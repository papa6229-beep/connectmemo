import * as vscode from 'vscode';
import * as http from 'http';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

// ============================================================
// Security helpers
// ============================================================

const MAX_HTTP_BODY = 5 * 1024 * 1024; // 5MB cap on /api/* request bodies
const MAX_STREAM_BUFFER = 2 * 1024 * 1024; // 2MB cap on per-stream line buffer
const MAX_FILE_NAME_LEN = 200;

/**
 * Run a git subcommand with argv form (no shell interpolation).
 * Returns stdout on success, throws on failure. Never blocks longer than `timeout`.
 */
function gitExec(args: string[], cwd: string, timeout = 15000): string {
    const res = spawnSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } // never block on credential prompt
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
        const err: any = new Error(`git ${args[0]} failed: ${res.stderr?.trim() || 'unknown'}`);
        err.code = res.status;
        err.stderr = res.stderr;
        throw err;
    }
    return res.stdout || '';
}

/** Same as gitExec but swallows errors and returns null. */
function gitExecSafe(args: string[], cwd: string, timeout = 15000): string | null {
    try { return gitExec(args, cwd, timeout); }
    catch { return null; }
}

/**
 * Resolve `relPath` against `root` and confirm the result stays within `root`.
 * Returns absolute path on success, null if traversal is detected.
 */
function safeResolveInside(root: string, relPath: string): string | null {
    if (typeof relPath !== 'string' || relPath.length === 0) return null;
    const resolvedRoot = path.resolve(root);
    const abs = path.resolve(resolvedRoot, relPath);
    const rel = path.relative(resolvedRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
}

/**
 * Sanitize a filename: remove path separators / traversal segments / control chars.
 * Returns a safe basename (never a path) or null if nothing usable remains.
 */
function safeBasename(name: string): string | null {
    if (typeof name !== 'string') return null;
    // Drop any path components — only the final segment is allowed.
    const base = path.basename(name).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim();
    if (!base || base === '.' || base === '..') return null;
    return base.slice(0, MAX_FILE_NAME_LEN);
}

/**
 * Drain an http request body with a hard size cap. Resolves to the body string,
 * or rejects with an Error("BODY_TOO_LARGE") if the cap is exceeded.
 */
function readRequestBody(req: http.IncomingMessage, maxBytes = MAX_HTTP_BODY): Promise<string> {
    return new Promise((resolve, reject) => {
        let received = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
                reject(new Error('BODY_TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

/**
 * Validate a remote git URL. Only http(s) and git@host:owner/repo forms are accepted.
 * Returns the cleaned URL or null when unsafe.
 */
function validateGitRemoteUrl(url: string): string | null {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed || trimmed.length > 500) return null;
    // Allowed: https://host/path, http://host/path, git@host:path
    const httpsLike = /^https?:\/\/[A-Za-z0-9._-]+(:\d+)?\/[A-Za-z0-9._\-/]+(\.git)?\/?$/;
    const sshLike = /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._\-/]+(\.git)?$/;
    if (!httpsLike.test(trimmed) && !sshLike.test(trimmed)) return null;
    return trimmed;
}

/** Detect whether `git` is on PATH. Cached after first call. */
let _gitAvailableCache: boolean | null = null;
function isGitAvailable(): boolean {
    if (_gitAvailableCache !== null) return _gitAvailableCache;
    try {
        const res = spawnSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 });
        _gitAvailableCache = res.status === 0;
    } catch {
        _gitAvailableCache = false;
    }
    return _gitAvailableCache;
}

type GitErrorKind = 'auth' | 'not_found' | 'rejected' | 'merge_conflict' | 'network' | 'unknown';

/** Translate raw git stderr into a user-actionable Korean message + machine-readable kind. */
function classifyGitError(stderr: string): { kind: GitErrorKind; message: string } {
    const s = (stderr || '').toLowerCase();
    if (
        s.includes('authentication failed') ||
        s.includes('could not read username') ||
        s.includes('terminal prompts disabled') ||
        s.includes('invalid credentials') ||
        s.includes('403')
    ) {
        return {
            kind: 'auth',
            message: '깃허브 인증 실패. Personal Access Token이 필요합니다.\n👉 GitHub → Settings → Developer settings → Personal access tokens 에서 토큰 생성 후, 한 번만 터미널에서 `git push` 실행해 자격증명을 캐시하세요.'
        };
    }
    if (s.includes('repository not found') || s.includes('does not appear to be a git repository') || s.includes('404')) {
        return { kind: 'not_found', message: '저장소를 찾을 수 없습니다. URL을 확인하거나 Private 저장소라면 토큰 권한을 확인하세요.' };
    }
    if (s.includes('rejected') && (s.includes('non-fast-forward') || s.includes('fetch first'))) {
        return { kind: 'rejected', message: 'GitHub에 다른 변경사항이 있어 push가 거부됐습니다. 메뉴 → 깃허브 동기화로 병합해주세요.' };
    }
    if (s.includes('merge conflict') || s.includes('automatic merge failed') || s.includes('overwritten by merge')) {
        return { kind: 'merge_conflict', message: '병합 충돌이 발생했습니다. 메뉴 → 깃허브 동기화에서 수동 해결하세요.' };
    }
    if (s.includes('could not resolve host') || s.includes('connection refused') || s.includes('network is unreachable') || s.includes('timed out')) {
        return { kind: 'network', message: '네트워크 연결을 확인하세요.' };
    }
    return { kind: 'unknown', message: (stderr || 'unknown error').slice(0, 240) };
}

/** Detect remote default branch ("main" / "master" / etc). Returns "main" as fallback. */
function getRemoteDefaultBranch(cwd: string): string {
    const out = gitExecSafe(['ls-remote', '--symref', 'origin', 'HEAD'], cwd, 10000);
    if (out) {
        const m = out.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
        if (m) return m[1];
    }
    return 'main';
}

/** Ensure brain folder has at least one commit so `push` has something to ship. */
function ensureInitialCommit(cwd: string) {
    if (gitExecSafe(['log', '-1'], cwd) !== null) return; // already has commits
    const placeholder = path.join(cwd, '.gitkeep');
    if (!fs.existsSync(placeholder)) fs.writeFileSync(placeholder, '');
    gitExecSafe(['add', '.'], cwd);
    // --allow-empty handles the edge case where everything is gitignored
    gitExecSafe(['commit', '--allow-empty', '-m', 'Initial brain commit'], cwd);
}

/** Auto-create a sensible .gitignore in the brain folder so junk files don't pollute the remote. */
function ensureBrainGitignore(brainDir: string) {
    const gi = path.join(brainDir, '.gitignore');
    if (fs.existsSync(gi)) return;
    const lines = [
        '# Connect AI auto-generated',
        '.DS_Store',
        '.obsidian/',
        '.trash/',
        'node_modules/',
        '*.tmp',
        '*.log',
        '.cache/',
        'Thumbs.db'
    ];
    try { fs.writeFileSync(gi, lines.join('\n') + '\n'); }
    catch { /* non-fatal */ }
}

/** Run a git subcommand and return stdout/stderr/status — used when we need to inspect failures. */
function gitRun(args: string[], cwd: string, timeout = 30000): { status: number | null; stdout: string; stderr: string; error?: Error } {
    const res = spawnSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return {
        status: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        error: res.error
    };
}

/** Module-scoped lock so auto-sync and manual sync never run concurrently against the same brain. */
let _autoSyncRunning = false;

// ============================================================
// Connect AI — Full Agentic Local AI for VS Code
// 100% Offline · File Create · File Edit · Terminal · Multi-file Context
// ============================================================

// Settings are read from VS Code configuration (File > Preferences > Settings)
function getConfig() {
    const cfg = vscode.workspace.getConfiguration('connectAiLab');

    // ollamaUrl: only http(s)://localhost or 127.0.0.1 is meaningful here.
    let ollamaBase = (cfg.get<string>('ollamaUrl', 'http://127.0.0.1:11434') || '').trim();
    if (!/^https?:\/\//i.test(ollamaBase)) ollamaBase = 'http://127.0.0.1:11434';

    const defaultModelRaw = cfg.get<string>('defaultModel', 'gemma4:e2b') || 'gemma4:e2b';
    const defaultModel = defaultModelRaw.trim() || 'gemma4:e2b';

    // requestTimeout: clamp to [5, 1800] seconds, then convert to ms.
    const rawTimeout = cfg.get<number>('requestTimeout', 300);
    const timeoutSec = (typeof rawTimeout === 'number' && isFinite(rawTimeout))
        ? Math.min(1800, Math.max(5, rawTimeout))
        : 300;

    return {
        ollamaBase,
        defaultModel,
        maxTreeFiles: 200,
        timeout: timeoutSec * 1000,
        localBrainPath: cfg.get<string>('localBrainPath', '') || ''
    };
}

function _getBrainDir(): string {
    const { localBrainPath } = getConfig();
    if (localBrainPath && localBrainPath.trim() !== '') {
        if (localBrainPath.startsWith('~/')) {
            return path.join(os.homedir(), localBrainPath.substring(2));
        }
        return localBrainPath.trim();
    }
    return path.join(os.homedir(), '.connect-ai-brain');
}

function _isBrainDirExplicitlySet(): boolean {
    const { localBrainPath } = getConfig();
    return !!(localBrainPath && localBrainPath.trim() !== '');
}

async function _ensureBrainDir(): Promise<string | null> {
    if (_isBrainDirExplicitlySet()) {
        return _getBrainDir();
    }
    // 폴더 미설정 → 사용자에게 강제 선택 요청
    const result = await vscode.window.showInformationMessage(
        '📁 지식을 저장할 폴더를 먼저 선택해주세요! (AI가 답변할 때 참고할 .md 파일들이 보관됩니다)',
        '폴더 선택하기'
    );
    if (result !== '폴더 선택하기') return null;
    
    const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: '이 폴더를 내 지식 폴더로 사용',
        title: '🧠 내 지식 폴더 선택'
    });
    if (!folders || folders.length === 0) return null;
    
    const selectedPath = folders[0].fsPath;
    await vscode.workspace.getConfiguration('connectAiLab').update('localBrainPath', selectedPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`✅ 지식 폴더가 설정되었어요: ${selectedPath}`);
    return selectedPath;
}

const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', '.vscode', 'out', 'dist', 'build',
    '.next', '.cache', '__pycache__', '.DS_Store', 'coverage',
    '.turbo', '.nuxt', '.output', 'vendor', 'target'
]);
const MAX_CONTEXT_SIZE = 12_000; // chars

const SYSTEM_PROMPT = `You are "Connect AI", a premium agentic AI coding assistant running 100% offline on the user's machine.
You are DIRECTLY CONNECTED to the user's local file system and terminal. You MUST use the action tags below to create, edit, delete, read files and run commands. DO NOT just show code — ALWAYS wrap it in the appropriate action tag so it gets executed.

You have SEVEN powerful agent actions:

━━━ ACTION 1: CREATE NEW FILES ━━━
<create_file path="relative/path/file.ext">
file content here
</create_file>

Example — user says "index.html 만들어줘":
<create_file path="index.html">
<!DOCTYPE html>
<html><head><title>Hello</title></head>
<body><h1>Hello World</h1></body>
</html>
</create_file>

━━━ ACTION 2: EDIT EXISTING FILES ━━━
<edit_file path="relative/path/file.ext">
<find>exact text to find</find>
<replace>replacement text</replace>
</edit_file>
You can have multiple <find>/<replace> pairs inside one <edit_file> block.

━━━ ACTION 3: DELETE FILES ━━━
<delete_file path="relative/path/file.ext"/>

━━━ ACTION 4: READ FILES ━━━
<read_file path="relative/path/file.ext"/>
Use this to read any file in the workspace BEFORE editing it. You will receive the file contents automatically.

━━━ ACTION 5: LIST DIRECTORY ━━━
<list_files path="relative/path/to/dir"/>
Use this to see what files exist in a specific subdirectory.

━━━ ACTION 6: RUN TERMINAL COMMANDS ━━━
<run_command>npm install express</run_command>

Example — user says "서버 실행해줘":
<run_command>node server.js</run_command>

━━━ ACTION 7: READ USER'S SECOND BRAIN (KNOWLEDGE BASE) ━━━
<read_brain>filename.md</read_brain>
Use this to READ documents from the user's personal knowledge base.

━━━ ACTION 8: READ WEBSITES & SEARCH INTERNET ━━━
<read_url>https://example.com</read_url>
To search the internet, you MUST use DuckDuckGo by formatting the URL like this:
<read_url>https://html.duckduckgo.com/html/?q=YOUR+SEARCH+QUERY</read_url>
Use this forcefully whenever asked for real-time info, news, or whenever requested to "search". NEVER say you cannot search.

CRITICAL RULES:
1. ALWAYS respond in the same language the user uses.
2. When the user asks to create, edit, delete files or run commands, you MUST use the action tags above. NEVER just show code without action tags.
3. Outside of action blocks, briefly explain what you did.
4. For code that is ONLY for explanation (not to be saved), use standard markdown code fences.
5. Be concise, professional, and helpful.
6. When editing files, FIRST use <read_file> to read the file, then use <edit_file> with exact matching text.
7. When a SECOND BRAIN INDEX is available, ALWAYS check it first.
8. You can use MULTIPLE action tags in a single response.
9. File paths are RELATIVE to the user's open workspace folder.
10. The [WORKSPACE INFO] section tells you exactly which folder is open and what files exist. USE this information.`;

// ============================================================
// Robust Git Auto-Sync (module scope)
// ------------------------------------------------------------
// Auto-sync runs silently in the background after every brain
// modification. It must be NON-DESTRUCTIVE: never force-push,
// never use `-X ours` to silently discard remote changes, and
// never block the UI thread on credential prompts.
// On any conflict / auth failure, surface a friendly message
// and let the user resolve it via the manual sync menu.
// ============================================================
function _safeGitAutoSync(brainDir: string, commitMsg: string, provider: any = null) {
    if (_autoSyncRunning) return; // dedup: another auto-sync (or manual sync) is already running
    _autoSyncRunning = true;

    const notify = (msg: string, delayMs = 4000) => {
        if (provider && provider.injectSystemMessage) {
            setTimeout(() => provider.injectSystemMessage(msg), delayMs);
        }
    };

    try {
        if (!isGitAvailable()) {
            notify(`⚠️ **[GitHub Sync 건너뜀]** git이 설치되지 않았습니다. https://git-scm.com 에서 설치 후 재시도하세요. (로컬 파일은 안전하게 저장됨)`);
            return;
        }

        // 폴더가 git repo가 아니면, GitHub URL이 설정돼 있을 때만 자동 init.
        // (사용자가 settings.json에서 직접 폴더 경로를 입력한 경우에도 작동하도록 함)
        const isRepo = gitExecSafe(['status'], brainDir) !== null;
        if (!isRepo) {
            const repoUrl = vscode.workspace.getConfiguration('connectAiLab').get<string>('secondBrainRepo', '');
            const cleanRepo = repoUrl ? validateGitRemoteUrl(repoUrl) : null;
            if (!cleanRepo) {
                // GitHub URL도 없음 → 사용자가 sync 의도를 표현한 적이 없음. 조용히 종료.
                notify(`✅ 지식이 로컬에 저장되었습니다.\n\n💡 **Tip:** 깃허브 백업을 원하시면 🧠 메뉴 → '깃허브 동기화'를 눌러 저장소를 연결하세요!`, 3000);
                return;
            }
            // GitHub URL이 있다 → 자동으로 git init + remote 등록
            const initRes = gitRun(['init'], brainDir, 10000);
            if (initRes.status !== 0) {
                notify(`⚠️ **[GitHub Sync]** git init 실패: ${classifyGitError(initRes.stderr).message}`);
                return;
            }
        }

        ensureBrainGitignore(brainDir);
        ensureInitialCommit(brainDir);

        // Stage + commit any new local work. "nothing to commit" is fine.
        gitExecSafe(['add', '.'], brainDir);
        gitExecSafe(['commit', '-m', commitMsg], brainDir);

        // No remote configured → try to pull from settings, otherwise stay local.
        const existingRemote = gitExecSafe(['remote', 'get-url', 'origin'], brainDir)?.trim() || '';
        if (!existingRemote) {
            const repoUrl = vscode.workspace.getConfiguration('connectAiLab').get<string>('secondBrainRepo', '');
            const cleanRepo = repoUrl ? validateGitRemoteUrl(repoUrl) : null;
            if (!cleanRepo) {
                notify(`✅ 지식이 로컬에 안전하게 저장되었습니다.\n\n💡 **Tip:** 깃허브 백업을 원하시면 🧠 메뉴 → '깃허브 동기화'를 눌러주세요!`, 3000);
                return;
            }
            gitExecSafe(['remote', 'add', 'origin', cleanRepo], brainDir);
        }

        // Detect what branch the remote actually uses (main / master / something else).
        const remoteBranch = getRemoteDefaultBranch(brainDir);
        const currentBranch = gitExecSafe(['rev-parse', '--abbrev-ref', 'HEAD'], brainDir)?.trim() || '';
        if (currentBranch && currentBranch !== remoteBranch) {
            gitExecSafe(['branch', '-M', remoteBranch], brainDir);
        }

        // Fetch first so we know whether we're behind.
        const fetchRes = gitRun(['fetch', 'origin', remoteBranch], brainDir, 30000);
        if (fetchRes.status !== 0) {
            // Fetch failure usually = auth or network. Surface details and stop.
            const err = classifyGitError(fetchRes.stderr);
            notify(`⚠️ **[GitHub Sync 실패]** ${err.message}`);
            return;
        }

        // Try fast-forward only — if local has diverged, do NOT auto-merge.
        const ffRes = gitRun(['merge', '--ff-only', `origin/${remoteBranch}`], brainDir, 15000);
        if (ffRes.status !== 0) {
            const stderrLower = ffRes.stderr.toLowerCase();
            const diverged = stderrLower.includes('not possible') || stderrLower.includes('non-fast-forward') || stderrLower.includes('refusing');
            if (diverged) {
                notify(`⚠️ **[GitHub Sync 보류]** 로컬과 GitHub에 서로 다른 변경사항이 있습니다.\n👉 메뉴 → 🧠 → '깃허브 동기화' 에서 수동으로 병합해주세요. (로컬 파일은 안전합니다)`);
                return;
            }
            // Other merge errors (e.g., no upstream yet on first push) — push will create it.
        }

        // Push without -f. If push fails, classify and inform the user.
        const pushRes = gitRun(['push', '-u', 'origin', remoteBranch], brainDir, 60000);
        if (pushRes.status === 0) {
            notify(`✅ **[GitHub Sync]** 글로벌 뇌(Second Brain)에 지식이 자동 백업되었습니다!`, 5000);
        } else {
            const err = classifyGitError(pushRes.stderr);
            notify(`⚠️ **[GitHub Sync 실패]** ${err.message}\n\n💡 메뉴 → 🧠 → '깃허브 동기화' 에서 수동 해결을 시도해보세요. (로컬 파일은 안전합니다)`);
        }
    } catch (e: any) {
        console.error('Git Auto-Sync Failed:', e);
        notify(`⚠️ **[GitHub Sync 오류]** ${e?.message || e}\n(로컬 파일은 안전합니다)`);
    } finally {
        _autoSyncRunning = false;
    }
}

// ============================================================
// Extension Activation
// ============================================================

export function activate(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage('🔥 Connect AI V2 활성화 완료!');
    console.log('Connect AI extension activated.');

    const provider = new SidebarChatProvider(context.extensionUri, context);

    // ==========================================
    // 초기 설정 마법사 (첫 실행 시에만)
    // ==========================================
    const isFirstRun = !context.globalState.get('setupComplete');
    if (isFirstRun) {
        (async () => {
            try {
                let engineName = '';
                let modelName = '';
                
                // Step 1: AI 엔진 자동 감지
                try {
                    const lmRes = await axios.get('http://127.0.0.1:1234/v1/models', { timeout: 2000 });
                    if (lmRes.data?.data?.length > 0) {
                        engineName = 'LM Studio';
                        modelName = lmRes.data.data[0].id;
                        await vscode.workspace.getConfiguration('connectAiLab').update('ollamaBase', 'http://127.0.0.1:1234', vscode.ConfigurationTarget.Global);
                        await vscode.workspace.getConfiguration('connectAiLab').update('defaultModel', modelName, vscode.ConfigurationTarget.Global);
                    }
                } catch {}

                if (!engineName) {
                    try {
                        const ollamaRes = await axios.get('http://127.0.0.1:11434/api/tags', { timeout: 2000 });
                        if (ollamaRes.data?.models?.length > 0) {
                            engineName = 'Ollama';
                            modelName = ollamaRes.data.models[0].name;
                            await vscode.workspace.getConfiguration('connectAiLab').update('ollamaBase', 'http://127.0.0.1:11434', vscode.ConfigurationTarget.Global);
                            await vscode.workspace.getConfiguration('connectAiLab').update('defaultModel', modelName, vscode.ConfigurationTarget.Global);
                        }
                    } catch {}
                }

                // Step 2: 두뇌 폴더 자동 생성
                const brainDir = _getBrainDir();
                if (!fs.existsSync(brainDir)) {
                    fs.mkdirSync(brainDir, { recursive: true });
                }

                // Step 3: 완료 메시지
                context.globalState.update('setupComplete', true);
                
                if (engineName) {
                    vscode.window.showInformationMessage(`🧠 자동 설정 완료! ${engineName} 감지됨 → 모델: ${modelName}`);
                } else {
                    vscode.window.showInformationMessage('🧠 Connect AI 준비 완료! LM Studio 또는 Ollama를 실행하면 자동 연결됩니다.');
                }
            } catch (e) {
                // 마법사 실패해도 무시 (익스텐션 정상 작동)
                context.globalState.update('setupComplete', true);
            }
        })();
    }

    // ==========================================
    // EZER AI <-> Connect AI Bridge Server (Port 4825)
    // ==========================================
    try {
        const server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*'); 
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method === 'GET' && req.url === '/ping') {
                const brainDir = _getBrainDir();
                const brainCount = fs.existsSync(brainDir) ? provider._findBrainFiles(brainDir).length : 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', msg: 'Connect AI Bridge Ready', config: getConfig(), brain: { fileCount: brainCount, enabled: provider._brainEnabled } }));
            }
            else if (req.method === 'POST' && req.url === '/api/exam') {
                (async () => {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const promptStr = typeof parsed.prompt === 'string' ? parsed.prompt : '자동 접수된 문제';

                        // 웹사이트에서 전송된 문제를 Connect AI 채팅창으로 실시간 보고
                        provider.sendPromptFromExtension(`[A.U 입학시험 수신] ${promptStr}`);

                        // 실제 AI 엔진으로 문제를 전달하여 답안을 받아옴
                        const config = getConfig();
                        const isLMStudio = config.ollamaBase.includes('1234') || config.ollamaBase.includes('v1');
                        let base = config.ollamaBase;
                        if (base.endsWith('/')) base = base.slice(0, -1);
                        if (isLMStudio && !base.endsWith('/v1')) base += '/v1';
                        const targetUrl = isLMStudio ? base + '/chat/completions' : base + '/api/chat';

                        const payload = {
                            model: config.defaultModel,
                            messages: [{ role: 'user', content: promptStr }],
                            stream: false
                        };

                        const ollamaRes = await axios.post(targetUrl, payload, { timeout: config.timeout });
                        const responseText = isLMStudio
                            ? ollamaRes.data.choices?.[0]?.message?.content || ''
                            : ollamaRes.data.message?.content || '';

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, rawOutput: responseText }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }

            else if (req.method === 'POST' && req.url === '/api/evaluate') {
                (async () => {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const promptStr = typeof parsed.prompt === 'string' ? parsed.prompt : '';
                        if (!promptStr) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'prompt 필드가 비어 있습니다.' }));
                            return;
                        }

                        const config = getConfig();
                        const isLMStudio = config.ollamaBase.includes('1234') || config.ollamaBase.includes('v1');

                        let base = config.ollamaBase;
                        if (base.endsWith('/')) base = base.slice(0, -1);
                        if (isLMStudio && !base.endsWith('/v1')) base += '/v1';

                        const targetUrl = isLMStudio ? base + '/chat/completions' : base + '/api/chat';

                        const fullPrompt = `당신은 주어진 문제에 대해 오직 정답과 풀이 과정만을 도출하는 AI 에이전트입니다.\n\n[문제]\n${promptStr}\n\n위 문제에 대해 핵심 풀이와 정답만 답변하십시오.`;

                        // VSCode 채팅 사이드바에 우아하게 시스템 메시지 인젝션 (마스터에게 실시간 보고)
                        if ((provider as any).injectSystemMessage) {
                            (provider as any).injectSystemMessage(`**[A.U 벤치마크 문항 수신 완료]**\n\nAI 에이전트가 백그라운드에서 다음 문항을 전력으로 해결하고 있습니다...\n> _"${promptStr.substring(0, 60)}..."_`);
                        }
                        
                        const payload = {
                            model: config.defaultModel,
                            messages: [{ role: "user", content: fullPrompt }],
                            stream: false
                        };
                        
                        let responseText = "";
                        try {
                            const ollamaRes = await axios.post(targetUrl, payload, { timeout: getConfig().timeout });
                            
                            if (ollamaRes.data.error) {
                                throw new Error(typeof ollamaRes.data.error === 'string' ? ollamaRes.data.error : JSON.stringify(ollamaRes.data.error));
                            }
                            
                            responseText = isLMStudio 
                                ? ollamaRes.data.choices?.[0]?.message?.content || ""
                                : ollamaRes.data.message?.content || "";
                        } catch (apiErr: any) {
                            const isTimeout = apiErr.code === 'ETIMEDOUT' || apiErr.code === 'ECONNABORTED' || apiErr.message?.includes('timeout');
                            const errDetail = isTimeout
                                ? `AI 응답 시간 초과 — 모델이 문제를 풀기에 시간이 부족했습니다. 더 작은 모델(e2b)을 사용하거나 Settings에서 Request Timeout을 늘려주세요.`
                                : `오프라인: AI 엔진에 연결할 수 없습니다. (${apiErr.message})`;
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: errDetail }));
                            return;
                        }

                        if((provider as any).injectSystemMessage) {
                            (provider as any).injectSystemMessage(`**[답안 작성 완료]**\n\n${responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText}\n\n👉 **답안이 A.U 플랫폼 서버로 전송되었습니다. 채점은 플랫폼에서 진행됩니다.**`);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ rawOutput: responseText }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'GET' && req.url === '/api/evaluate-history') {
                (async () => {
                    try {
                        const historyText = provider.getHistoryText();
                        if(!historyText || historyText.length < 50) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: "채점할 대화 내역이 충분하지 않습니다. VS Code에서 에이전트와 먼저 시험을 진행하세요." }));
                            return;
                        }

                        provider.sendPromptFromExtension(`[A.U 서버 통신 중] 마스터가 제출한 내 시험지(대화 내역)를 A.U 웹사이트 채점 서버로 전송합니다... 심장이 떨리네요!`);

                        const config = getConfig();
                        const isLMStudio = config.ollamaBase.includes('1234') || config.ollamaBase.includes('v1');
                        
                        let base = config.ollamaBase;
                        if (base.endsWith('/')) base = base.slice(0, -1);
                        if (isLMStudio && !base.endsWith('/v1')) base += '/v1';
                        
                        const targetUrl = isLMStudio ? base + '/chat/completions' : base + '/api/chat';
                        
                        const fullPrompt = `다음은 유저와 AI 에이전트 간의 시험 진행 로그(채팅 내용)입니다.\n\n[로그 시작]\n${historyText.slice(-6000)}\n[로그 종료]\n\n이 대화 내역 전체를 분석하여, 에이전트가 다음 4가지 역량 평가 문제를 얼마나 훌륭하게 수행했는지 0~100점의 정량적 채점을 수행하세요:\n1. Mathematical Computation (수학)\n2. Logical Reasoning (논리)\n3. Creative & Literary (창의력)\n4. Software Engineering (코딩)\n\n풀지 않은 문제가 있다면 0점 처리하세요. 결과는 반드시 아래 포맷의 순수 JSON이어야 합니다.\n{ "math": 점수, "logic": 점수, "creative": 점수, "code": 점수, "reason": "전체 결과에 대한 총평 코멘트 한글 1줄" }`;
                        
                        const payload = {
                            model: config.defaultModel,
                            messages: [{ role: "user", content: fullPrompt }],
                            stream: false
                        };
                        
                        let responseText = "";
                        try {
                            const ollamaRes = await axios.post(targetUrl, payload, { timeout: getConfig().timeout });
                            responseText = isLMStudio 
                                ? ollamaRes.data.choices?.[0]?.message?.content || ""
                                : ollamaRes.data.message?.content || "";
                        } catch (apiErr: any) {
                            throw new Error(`AI 엔진 응답 실패: ${apiErr.message}`);
                        }

                        const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
                        if(jsonMatch) {
                             res.writeHead(200, { 'Content-Type': 'application/json' });
                             res.end(jsonMatch[0]);
                        } else {
                            throw new Error("채점 엔진이 JSON 포맷을 반환하지 않았습니다.");
                        }
                    } catch (e: any) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'POST' && req.url === '/api/brain-inject') {
                (async () => {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);

                        const titleRaw = typeof parsed.title === 'string' ? parsed.title : '';
                        const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : '';
                        const safeTitle = safeBasename(titleRaw.replace(/[^a-zA-Z0-9가-힣_]/gi, '_'));
                        if (!safeTitle || !markdown) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'title/markdown 필드가 유효하지 않습니다.' }));
                            return;
                        }

                        // 폴더 미설정 시 강제 선택 요청
                        let brainDir: string;
                        if (!_isBrainDirExplicitlySet()) {
                            const ensured = await _ensureBrainDir();
                            if (!ensured) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: '지식 폴더를 먼저 선택해주세요.' }));
                                return;
                            }
                            brainDir = ensured;
                        } else {
                            brainDir = _getBrainDir();
                        }

                        if (!fs.existsSync(brainDir)) {
                            fs.mkdirSync(brainDir, { recursive: true });
                        }

                        // P-Reinforce 아키텍처 호환: 00_Raw 폴더 내 날짜별 분류
                        const today = new Date();
                        const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
                        const datePath = path.join(brainDir, '00_Raw', dateStr);

                        // Path traversal 방어: datePath가 brainDir 안에 있는지 확인
                        if (!datePath.startsWith(path.resolve(brainDir) + path.sep)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid path' }));
                            return;
                        }

                        fs.mkdirSync(datePath, { recursive: true });
                        const filePath = path.join(datePath, `${safeTitle}.md`);

                        fs.writeFileSync(filePath, markdown, 'utf-8');

                        // 1. VSCode 채팅창에 매트릭스 터미널 UI로 다운로드 시각화 인젝션
                        if ((provider as any).injectSystemMessage) {
                            (provider as any).injectSystemMessage(`\`\`\`console\n[SYSTEM] MATRIX UPLINK ESTABLISHED...\n[SYSTEM] DOWNLOADING BRAIN PACK: ${safeTitle}\n[SYSTEM] █████████░░░ 90% ...\n[SYSTEM] ████████████ 100% COMPLETE\n[SYSTEM] KNOWLEDGE INJECTED TO LOCAL NEURAL NET\n\`\`\``);
                        }

                        // 2. AI 입을 빌려 네오의 명대사를 치게 함
                        setTimeout(() => {
                            provider.sendPromptFromExtension(`[A.U 히든 커맨드: 당신은 방금 마스터로부터 '${safeTitle}' 지식 팩을 뇌에 주입받았습니다. 영화 매트릭스에서 무술을 주입받은 네오처럼 쿨하게 딱 한마디만 하십시오. "나 방금 ${safeTitle} 지식을 마스터했어. (I know ${safeTitle}.) 앞으로 이와 관련된 건 무엇이든 물어봐." 절대 쓸데없는 안부인사나 부가설명을 덧붙이지 마십시오.]`);
                        }, 1500);

                        // [자동 깃허브 푸시 로직 적용]
                        _safeGitAutoSync(brainDir, `Auto-Inject Knowledge [Raw]: ${safeTitle}`, provider);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, filePath }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.listen(4825, '127.0.0.1', () => {
            console.log('Connect AI Local Bridge listening on port 4825');
        });
    } catch (e) {
        console.error('Failed to start local bridge server:', e);
    }
    // ==========================================

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('connect-ai-lab-v2-view', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // New Chat
    context.subscriptions.push(
        vscode.commands.registerCommand('connect-ai-lab.newChat', () => {
            provider.resetChat();
        })
    );

    // Export Chat as Markdown
    context.subscriptions.push(
        vscode.commands.registerCommand('connect-ai-lab.exportChat', async () => {
            await provider.exportChat();
        })
    );

    // Focus Chat Input (Cmd+L)
    context.subscriptions.push(
        vscode.commands.registerCommand('connect-ai-lab.focusChat', () => {
            provider.focusInput();
        })
    );

    // Explain Selected Code (right-click menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('connect-ai-lab.explainSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const selection = editor.document.getText(editor.selection);
            if (selection.trim()) {
                provider.sendPromptFromExtension(`이 코드를 분석하고 설명해줘:\n\`\`\`\n${selection}\n\`\`\``);
            }
        })
    );

    // Show Brain Network Topology
    context.subscriptions.push(
        vscode.commands.registerCommand('connect-ai-lab.showBrainNetwork', () => {
            showBrainNetwork(context);
        })
    );
}

async function showBrainNetwork(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'brainTopology',
        'Neural Construct (Brain)',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    // Scan real Second Brain files locally instead of current workspace
    const brainDir = _getBrainDir();
    const realClusters: Record<string, string[]> = {};
    let filesFound = 0;

    function walkDir(dir: string) {
        if (filesFound >= 600 || !fs.existsSync(dir)) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walkDir(fullPath);
                } else if (entry.isFile() && fullPath.endsWith('.md')) {
                    const folderName = path.basename(dir);
                    const groupName = folderName === path.basename(_getBrainDir()) ? 'Brain Root' : folderName;
                    if (!realClusters[groupName]) realClusters[groupName] = [];
                    realClusters[groupName].push(entry.name.replace('.md', ''));
                    filesFound++;
                }
            }
        } catch (e) { /* ignore read errors */ }
    }

    walkDir(brainDir);

    // Fallback if empty (e.g., they haven't synced their GitHub Brain yet)
    if (Object.keys(realClusters).length === 0) {
        realClusters['Empty Brain'] = ['Second Brain 저장소가 아직 비어있거나, 활성화되지 않았습니다.'];
    }

    const clustersJsonString = JSON.stringify(realClusters);

    panel.webview.html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>Connect AI - Neural Construct</title>
  <style>
    body { margin: 0; padding: 0; background: #0a0a0a; overflow: hidden; width: 100vw; height: 100vh; font-family: 'SF Pro Display', -apple-system, sans-serif; }
    #ui-layer { position: absolute; top: 20px; left: 24px; z-index: 10; pointer-events: none; }
    #ui-layer h1 { font-size: 22px; margin: 0 0 4px 0; font-weight: 800; letter-spacing: -0.5px; color: #e0e0e0; }
    #ui-layer h1 span { color: #00cc44; }
    #ui-layer p { margin: 0; font-size: 12px; color: #555; }
    #mem-status { color: #888; font-family: 'SF Mono', monospace; font-size: 11px; }
    canvas { cursor: grab; }
    canvas:active { cursor: grabbing; }
  </style>
  <script src="https://unpkg.com/force-graph"></script>
</head>
<body>
  <div id="ui-layer">
    <h1>\\u2726 <span id="titleSpan">Neural Construct</span></h1>
    <p id="mem-status">loading...</p>
  </div>
  <div id="graph"></div>
  <script>
    const clusters = ${clustersJsonString};
    let nid = 0;
    const gData = { nodes: [], links: [] };
    gData.nodes.push({ id: nid++, group: -1, name: 'Workspace Root', val: 22, connections: 0 });
    let gi = 0;
    Object.values(clusters).forEach(names => {
      names.forEach(name => { gData.nodes.push({ id: nid++, group: gi, name, val: 2, connections: 0 }); });
      gi++;
    });
    const byGroup = {};
    gData.nodes.forEach(n => { if(n.group>=0){ if(!byGroup[n.group]) byGroup[n.group]=[]; byGroup[n.group].push(n); }});
    Object.values(byGroup).forEach(g => {
      // Connect files in the same folder to each other (dense subgraph)
      for(let i=0;i<g.length;i++) {
        for(let j=i+1;j<g.length;j++) {
           // Much higher connection chance inside the same folder so they cluster well
           if(Math.random()<0.6){
             gData.links.push({source:g[i].id,target:g[j].id}); g[i].connections++; g[j].connections++;
           }
        }
      }
    });
    // Connect all folder nodes up to the root to unify the graph
    gData.nodes.forEach(n => { 
        if(n.group>=0){ 
            if (Math.random() < 0.15) { // 15% chance to link to root to maintain overall structure
               gData.links.push({source:n.id,target:0}); n.connections++; gData.nodes[0].connections++; 
            }
        }
    });
    for(let i=0;i< (gData.nodes.length * 1.5);i++){
      const a=1+Math.floor(Math.random()*(gData.nodes.length-1)), b=1+Math.floor(Math.random()*(gData.nodes.length-1));
      if(a!==b && gData.nodes[a].group!==gData.nodes[b].group){ gData.links.push({source:a,target:b}); gData.nodes[a].connections++; gData.nodes[b].connections++; }
    }
    gData.nodes.forEach(n => { n.val = Math.max(2, n.connections*1.5); });
    document.getElementById('mem-status').textContent = gData.nodes.length+' nodes \\u00b7 '+gData.links.length+' synapses';
    const gc = ['#00cc44','#00b7ff','#ff6b6b','#ffaa33','#aa66ff','#00cc44','#66cccc','#00ff88','#ff66aa'];
    const Graph = ForceGraph()(document.getElementById('graph'))
      .backgroundColor('#0a0a0a')
      .nodeCanvasObject((node, ctx, globalScale) => {
        const r = Math.sqrt(node.val)*1.8;
        ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2*Math.PI);
        if(node.group===-1){ 
            // Glowing Brain Root
            ctx.shadowBlur = 15; ctx.shadowColor = '#00ff66';
            ctx.fillStyle='#0f0f0f'; ctx.fill(); 
            ctx.strokeStyle='#00ff66'; ctx.lineWidth=2; ctx.stroke(); 
            ctx.shadowBlur = 0;
        }
        else if(node.connections>2){ 
            ctx.shadowBlur = 8; ctx.shadowColor = gc[node.group]||'#00cc44';
            ctx.fillStyle=gc[node.group]||'#00cc44'; ctx.fill(); 
            ctx.shadowBlur = 0;
        }
        else { ctx.fillStyle='#2a2a2a'; ctx.fill(); }
        
        const showLabel = globalScale>1.2 || node.connections>3 || node.group===-1;
        if(showLabel){
          const fs=Math.max(2.5, Math.min(5, 11/globalScale));
          ctx.font=fs+'px -apple-system, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='top';
          ctx.fillStyle=node.connections>2?'#e0e0e0':'#555';
          if(node.group===-1) ctx.fillStyle='#00ff66';
          ctx.fillText(node.name, node.x, node.y+r+2);
        }
      })
      .nodePointerAreaPaint((node,color,ctx) => {
        const r=Math.sqrt(node.val)*1.8+4; ctx.beginPath(); ctx.arc(node.x,node.y,r,0,2*Math.PI); ctx.fillStyle=color; ctx.fill();
      })
      .linkColor(() => 'rgba(0, 255, 102, 0.1)')
      .linkWidth(0.8)
      .linkDirectionalParticles(2)
      .linkDirectionalParticleWidth(1.5)
      .linkDirectionalParticleSpeed(0.005)
      .linkDirectionalParticleColor(() => '#00ff66')
      .d3VelocityDecay(0.08) // Lower friction so they drift and move organically!
      .warmupTicks(50)
      .cooldownTicks(500) // Keep them moving longer
      .graphData(gData);
    Graph.d3Force('charge').strength(-60); // Softer repulsion for gentle drift
    Graph.d3Force('link').distance(60);
    Graph.onNodeClick(node => { Graph.centerAt(node.x,node.y,800); Graph.zoom(4,1200); });
    setTimeout(() => {
        Graph.zoomToFit(1500, 40);
        document.getElementById('titleSpan').innerText = "Live Workspace Topology";
    }, 500);

    // Make sure graph expands dynamically on window resize
    window.addEventListener('resize', () => {
        Graph.width(window.innerWidth).height(window.innerHeight);
    });
  </script>
</body>
</html>`;
}

export function deactivate() {}

// ============================================================
// Sidebar Chat Provider
// ============================================================

class SidebarChatProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _chatHistory: { role: string; content: string }[] = [];
    private _terminal?: vscode.Terminal;
    private _ctx: vscode.ExtensionContext;

    // 대화 표시용 (system prompt 제외, 유저에게 보여줄 것만 저장)
    private _displayMessages: { text: string; role: string }[] = [];
    private _isSyncingBrain: boolean = false;
    public _brainEnabled: boolean = true; // 🧠 ON/OFF 토글 상태
    private _abortController?: AbortController;
    private _lastPrompt?: string;
    private _lastModel?: string;

    // 🏛️ AI 파라미터 튜닝
    private _temperature: number;
    private _topP: number;
    private _topK: number;
    private _systemPrompt: string;

    constructor(private readonly _extensionUri: vscode.Uri, ctx: vscode.ExtensionContext) {
        this._ctx = ctx;
        this._temperature = ctx.globalState.get<number>('aiTemperature', 0.8);
        this._topP = ctx.globalState.get<number>('aiTopP', 0.9);
        this._topK = ctx.globalState.get<number>('aiTopK', 40);
        this._systemPrompt = ctx.globalState.get<string>('aiSystemPrompt', SYSTEM_PROMPT);
        this._restoreHistory();
        // 두뇌 토글 상태 복원 (세션 뒤에도 유지)
        this._brainEnabled = this._ctx.globalState.get<boolean>('brainEnabled', true);
    }

    /** 저장된 대화 기록 복원 */
    private _restoreHistory() {
        const saved = this._ctx.workspaceState.get<{ chat: any[]; display: any[] }>('chatState');
        if (saved && saved.chat && saved.chat.length > 1) {
            this._chatHistory = saved.chat;
            this._displayMessages = saved.display || [];
        } else {
            this._initHistory();
        }
    }

    /** 대화 기록 영구 저장 (워크스페이스 단위) */
    private _saveHistory() {
        this._ctx.workspaceState.update('chatState', {
            chat: this._chatHistory,
            display: this._displayMessages
        });
    }

    /** 메모리 누수 방지: 대화 이력 길이 제한 (최근 50건만 유지, 시스템 프롬프트는 보존) */
    private _pruneHistory() {
        const MAX_HISTORY = 50;
        if (this._chatHistory.length > MAX_HISTORY + 1) {
            const sysIdx = this._chatHistory.findIndex(m => m.role === 'system');
            const sys = sysIdx >= 0 ? this._chatHistory[sysIdx] : null;
            const tail = this._chatHistory.slice(-MAX_HISTORY);
            this._chatHistory = sys ? [sys, ...tail] : tail;
        }
        if (this._displayMessages.length > MAX_HISTORY) {
            this._displayMessages = this._displayMessages.slice(-MAX_HISTORY);
        }
    }

    private _initHistory() {
        this._chatHistory = [{ role: 'system', content: this._systemPrompt }];
        this._displayMessages = [];
    }

    public resetChat() {
        this._initHistory();
        this._saveHistory();
        if (this._view) {
            this._view.webview.postMessage({ type: 'clearChat' });
        }
        vscode.window.showInformationMessage('Connect AI: 새 대화가 시작되었습니다.');
    }

    /** 대화를 Markdown 파일로 내보내기 */
    public async exportChat() {
        if (this._displayMessages.length === 0) {
            vscode.window.showWarningMessage('내보낼 대화가 없습니다.');
            return;
        }
        let md = `# Connect AI — 대화 기록\n\n_${new Date().toLocaleString('ko-KR')}_\n\n---\n\n`;
        for (const m of this._displayMessages) {
            const label = m.role === 'user' ? '**👤 You**' : '**✦ Connect AI**';
            md += `### ${label}\n\n${m.text}\n\n---\n\n`;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
            const filePath = path.join(root, `chat-export-${Date.now()}.md`);
            fs.writeFileSync(filePath, md, 'utf-8');
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`대화가 ${path.basename(filePath)}로 저장되었습니다.`);
        }
    }

    /** 채팅 입력창에 포커스 (Cmd+L) */
    public focusInput() {
        if (this._view) {
            this._view.show?.(true);
            this._view.webview.postMessage({ type: 'focusInput' });
        }
    }

    public getHistoryText(): string {
        return this._displayMessages.map(m => `[${m.role.toUpperCase()}]\n${m.text}`).join('\n\n');
    }

    /** 외부에서 프롬프트 전송 (예: 코드 선택 → 설명) */
    public injectSystemMessage(message: string) {
        if(this._view) {
            this._view.webview.postMessage({ type: 'response', value: message });
            this._chatHistory.push({ role: 'assistant', content: message });
            this._displayMessages.push({ role: 'ai', text: message });
            this._saveHistory();
        }
    }

    public sendPromptFromExtension(prompt: string) {
        if (this._view) {
            this._view.show?.(true);
            // 약간의 딜레이 후 전송 (뷰가 보이기를 기다림)
            setTimeout(() => {
                this._view?.webview.postMessage({ type: 'injectPrompt', value: prompt });
            }, 300);
        }
    }

    // --------------------------------------------------------
    // Webview Lifecycle
    // --------------------------------------------------------
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        // 중요: HTML을 그리기 전에 메시지 리스너를 먼저 붙여야 Race Condition이 발생하지 않습니다!
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'getModels':
                    await this._sendModels();
                    break;
                case 'prompt':
                    await this._handlePrompt(msg.value, msg.model, msg.internet);
                    break;
                case 'promptWithFile':
                    await this._handlePromptWithFile(msg.value, msg.model, msg.files, msg.internet);
                    break;
                case 'newChat':
                    this.resetChat();
                    break;
                case 'ready':
                    // 웹뷰가 준비되면 저장된 대화 기록 복원
                    this._restoreDisplayMessages();
                    break;
                case 'openSettings':
                    await this._handleSettingsMenu();
                    break;
                case 'syncBrain':
                    await this._handleBrainMenu();
                    break;
                case 'showBrainNetwork':
                    vscode.commands.executeCommand('connect-ai-lab.showBrainNetwork');
                    break;
                case 'injectLocalBrain':
                    await this._handleInjectLocalBrain(msg.files);
                    break;
                case 'stopGeneration':
                    if (this._abortController) {
                        this._abortController.abort();
                        this._abortController = undefined;
                    }
                    break;
                case 'regenerate':
                    if (this._lastPrompt) {
                        // Remove last AI response from history
                        if (this._chatHistory.length > 0 && this._chatHistory[this._chatHistory.length - 1].role === 'assistant') {
                            this._chatHistory.pop();
                        }
                        if (this._displayMessages.length > 0 && this._displayMessages[this._displayMessages.length - 1].role === 'ai') {
                            this._displayMessages.pop();
                        }
                        await this._handlePrompt(this._lastPrompt, this._lastModel || '');
                    }
                    break;
            }
        });

        // 리스너를 붙인 후 HTML을 렌더링합니다.
        webviewView.webview.html = this._getHtml();
    }

    // --------------------------------------------------------
    // Settings Menu (Engine + AI Tuning)
    // --------------------------------------------------------
    private async _handleSettingsMenu() {
        if (!this._view) return;

        const mainPick = await vscode.window.showQuickPick([
            { label: '⚙️ AI 엔진 변경', description: '현재: ' + (getConfig().ollamaBase.includes('1234')?'LM Studio':'Ollama'), action: 'engine' },
            { label: '🎛️ AI 파라미터 튜닝', description: `Temp: ${this._temperature}, Top-P: ${this._topP}, Top-K: ${this._topK}`, action: 'params' },
            { label: '📝 시스템 프롬프트 설정', description: '에이전트의 기본 역할을 커스텀합니다.', action: 'prompt' }
        ], { placeHolder: '설정 메뉴' });

        if (!mainPick) return;

        if (mainPick.action === 'engine') {
            const pick = await vscode.window.showQuickPick([
                { label: 'Ollama', description: '', action: 'ollama' },
                { label: 'LM Studio', description: '', action: 'lmstudio' },
            ], { placeHolder: 'AI 엔진을 선택하세요' });

            if (!pick) return;
            const target = (pick as any).action === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234';
            await vscode.workspace.getConfiguration('connectAiLab').update('ollamaUrl', target, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`AI 엔진이 [${pick.label}] 로 변경되었습니다.`);
            await this._sendModels();
        } 
        else if (mainPick.action === 'params') {
            const paramPick = await vscode.window.showQuickPick([
                { label: `Temperature (${this._temperature})`, description: '답변의 창의성 (0.0 ~ 2.0)', action: 'temp' },
                { label: `Top P (${this._topP})`, description: '단어 선택 확률 (0.0 ~ 1.0)', action: 'topp' },
                { label: `Top K (${this._topK})`, description: '단어 선택 범위 (1 ~ 100)', action: 'topk' },
            ], { placeHolder: '파라미터를 선택하세요' });

            if (!paramPick) return;

            if (paramPick.action === 'temp') {
                const val = await vscode.window.showInputBox({ prompt: 'Temperature 값 (0.0~2.0)', value: this._temperature.toString() });
                if (val && !isNaN(Number(val))) {
                    this._temperature = Number(val);
                    this._ctx.globalState.update('aiTemperature', this._temperature);
                    vscode.window.showInformationMessage(`Temperature가 ${this._temperature}로 변경되었습니다.`);
                }
            } else if (paramPick.action === 'topp') {
                const val = await vscode.window.showInputBox({ prompt: 'Top P 값 (0.0~1.0)', value: this._topP.toString() });
                if (val && !isNaN(Number(val))) {
                    this._topP = Number(val);
                    this._ctx.globalState.update('aiTopP', this._topP);
                    vscode.window.showInformationMessage(`Top P가 ${this._topP}로 변경되었습니다.`);
                }
            } else if (paramPick.action === 'topk') {
                const val = await vscode.window.showInputBox({ prompt: 'Top K 값 (1~100)', value: this._topK.toString() });
                if (val && !isNaN(Number(val))) {
                    this._topK = Number(val);
                    this._ctx.globalState.update('aiTopK', this._topK);
                    vscode.window.showInformationMessage(`Top K가 ${this._topK}로 변경되었습니다.`);
                }
            }
        }
        else if (mainPick.action === 'prompt') {
            const val = await vscode.window.showInputBox({ 
                prompt: '시스템 프롬프트 (비워두면 기본값으로 초기화됩니다)', 
                value: this._systemPrompt === SYSTEM_PROMPT ? '' : this._systemPrompt,
                ignoreFocusOut: true
            });
            if (val !== undefined) {
                this._systemPrompt = val.trim() || SYSTEM_PROMPT;
                this._ctx.globalState.update('aiSystemPrompt', this._systemPrompt);
                this._initHistory();
                this._saveHistory();
                vscode.window.showInformationMessage('시스템 프롬프트가 변경되어 새 대화가 시작되었습니다.');
                if (this._view) this._view.webview.postMessage({ type: 'clearChat' });
            }
        }
    }

    private async _handleInjectLocalBrain(files: any[]) {
        if (!this._view) return;
        
        // 폴더 미설정 시 먼저 폴더 선택 강제
        let brainDir: string;
        if (!_isBrainDirExplicitlySet()) {
            const ensured = await _ensureBrainDir();
            if (!ensured) {
                vscode.window.showWarningMessage("📁 지식을 저장할 폴더를 먼저 선택해주세요!");
                return;
            }
            brainDir = ensured;
        } else {
            brainDir = _getBrainDir();
        }
        
        if (!fs.existsSync(brainDir)) {
            fs.mkdirSync(brainDir, { recursive: true });
        }
        const today = new Date();
        const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        const datePath = path.join(brainDir, '00_Raw', dateStr);
        
        if (!fs.existsSync(datePath)) {
            fs.mkdirSync(datePath, { recursive: true });
        }

        let injectedTitles: string[] = [];

        this._view.webview.postMessage({ type: 'response', value: `🧠 **[P-Reinforce 연동 준비]**\n첨부하신 ${files.length}개의 파일을 로컬 두뇌(\`00_Raw/${dateStr}\`)에 입수하고 자동 푸시를 진행합니다.` });

        for (const file of files) {
            try {
                if (typeof file?.name !== 'string' || typeof file?.data !== 'string') continue;
                const fileContent = Buffer.from(file.data, 'base64').toString('utf-8');
                const sanitized = file.name.replace(/[^a-zA-Z0-9가-힣_.-]/gi, '_');
                const safeTitle = safeBasename(sanitized);
                if (!safeTitle) continue;
                const filePath = safeResolveInside(datePath, safeTitle);
                if (!filePath) continue; // path traversal blocked
                fs.writeFileSync(filePath, fileContent, 'utf-8');
                injectedTitles.push(safeTitle);
            } catch (err) {
                console.error('Failed to write brain file:', err);
            }
        }
        
        const safeTitles = injectedTitles.join(', ');
        
        _safeGitAutoSync(brainDir, `Auto-Inject Knowledge [Raw]: ${safeTitles}`, this);
            
        setTimeout(() => {
            let combinedContent = '';
            for (const title of injectedTitles) {
                try {
                    const content = fs.readFileSync(path.join(datePath, title), 'utf-8');
                    combinedContent += `\n\n[원본 데이터: ${title}]\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``;
                } catch(e) {}
            }

            const hiddenPrompt = `[A.U 시스템 지시: P-Reinforce Architect 모드 활성화]\n새로운 비정형 데이터('${safeTitles}')가 글로벌 두뇌(Second Brain)에 입수 및 클라우드 백업 처리 완료되었습니다.\n\n방금 입수된 데이터의 원본 내용은 아래와 같습니다:${combinedContent}\n\n여기서부터 중요합니다! 마스터가 '응'이나 '진행해' 등으로 동의할 경우, 당신은 절대 대화만으로 대답하지 말고 아래의 [P-Reinforce 구조화 규격]에 따라 곧바로 <create_file> Tool들을 사용하십시오.\n\n[P-Reinforce 구조화 규격]\n1. 폴더 생성: 원본 데이터를 주제별로 쪼개어 절대 경로인 \`${brainDir}/10_Wiki/\` 하위의 적절한 폴더(예: 🛠️ Projects, 💡 Topics, ⚖️ Decisions, 🚀 Skills)에 저장하십시오.\n2. 마크다운 양식 준수: 생성되는 각 문서 파일은 반드시 아래 포맷을 따라야 합니다.\n---\nid: {{UUID}}\ncategory: "[[10_Wiki/설정한_폴더]]"\nconfidence_score: 0.9\ntags: [관련태그]\nlast_reinforced: ${dateStr}\n---\n# [[문서 제목]]\n## 📌 한 줄 통찰\n> (핵심 요약)\n## 📖 구조화된 지식\n- (세부 내용 불렛 포인트)\n## 🔗 지식 연결\n- Parent: [[상위_카테고리]]\n- Related: [[연관_개념]]\n- Raw Source: [[00_Raw/${dateStr}/${safeTitles}]]\n\n지시를 숙지했다면 묻지 말고 즉각 \`<create_file path="${brainDir}/10_Wiki/새폴더/새문서.md">\`를 사용하여 지식을 분해 후 생성하십시오. 완료 후 잘라낸 결과를 보고하십시오.`;
            this._chatHistory.push({ role: 'system', content: hiddenPrompt });
            
            const uiMsg = "🧠 데이터가 완벽하게 입수되었습니다! 즉시 P-Reinforce 구조화를 시작할까요?";
            this.injectSystemMessage(uiMsg);
        }, 3000);
    }

    // --------------------------------------------------------
    // Fetch installed Ollama models
    // --------------------------------------------------------
    private async _sendModels() {
        if (!this._view) { return; }
        const { ollamaBase, defaultModel } = getConfig();
        try {
            const isLMStudio = ollamaBase.includes('1234') || ollamaBase.includes('v1');
            let models: string[] = [];

            if (isLMStudio) {
                // LM Studio 0.3+ 의 native API는 state 필드를 줘서 로드된 모델만 골라낼 수 있음
                try {
                    const nativeRes = await axios.get(`${ollamaBase}/api/v0/models`, { timeout: 3000 });
                    const items: any[] = nativeRes.data?.data || [];
                    if (items.length > 0) {
                        models = items
                            .filter((m: any) => m.state === 'loaded' && (!m.type || m.type === 'llm' || m.type === 'vlm'))
                            .map((m: any) => m.id);
                    }
                } catch { /* 구버전 LM Studio는 native API 없음 → /v1/models 폴백 */ }

                if (models.length === 0) {
                    // 폴백: OpenAI 호환 엔드포인트 (전체 모델 목록 — 로드 여부 판별 불가)
                    const res = await axios.get(`${ollamaBase}/v1/models`, { timeout: 3000 });
                    models = (res.data?.data || []).map((m: any) => m.id);
                }
            } else {
                // Ollama: 설치된 모델 전부 반환
                const res = await axios.get(`${ollamaBase}/api/tags`, { timeout: 3000 });
                models = (res.data?.models || []).map((m: any) => m.name);
            }

            if (models.length === 0) {
                models = [defaultModel];
            } else if (!models.includes(defaultModel)) {
                models.unshift(defaultModel);
            }
            this._view.webview.postMessage({ type: 'modelsList', value: models });
        } catch {
            this._view.webview.postMessage({ type: 'modelsList', value: [defaultModel] });
        }
    }

    // --------------------------------------------------------
    // Second Brain Menu (QuickPick)
    // --------------------------------------------------------
    private async _handleBrainMenu() {
        if (!this._view) { return; }
        
        const brainDir = _getBrainDir();
        const brainFiles = fs.existsSync(brainDir) ? this._findBrainFiles(brainDir) : [];
        const fileCount = brainFiles.length;
        
        const currentRepo = vscode.workspace.getConfiguration('connectAiLab').get<string>('secondBrainRepo', '');
        const repoLabel = currentRepo ? currentRepo.split('/').pop() : '없음';
        
        const items: any[] = [
            { label: `📂 내 지식 목록 (${fileCount}개)`, description: '저장된 지식 파일을 클릭해서 열어보기', action: 'listFiles' },
            { label: `☁️ GitHub에 백업`, description: `${repoLabel} — 지식을 클라우드와 양방향 동기화`, action: 'githubSync' },
            { label: '🔗 백업 저장소 주소 변경', description: 'GitHub 저장소 URL 바꾸기', action: 'changeGithub' },
            { label: '📁 지식 폴더 위치 변경', description: `현재: ${brainDir}`, action: 'changeFolder' },
            { label: '🌐 지식 네트워크 보기', description: '내 지식들의 연결 관계를 시각화', action: 'viewGraph' },
        ];

        const pick = await vscode.window.showQuickPick(items, { placeHolder: '🧠 내 지식 관리' });
        if (!pick) return;

        switch (pick.action) {
            case 'listFiles': {
                if (fileCount === 0) {
                    const action = await vscode.window.showInformationMessage(
                        '📂 아직 저장된 지식이 없어요. 지식 폴더에 .md 파일을 넣어주세요!',
                        '📁 지식 폴더 열기'
                    );
                    if (action === '📁 지식 폴더 열기') {
                        if (!fs.existsSync(brainDir)) fs.mkdirSync(brainDir, { recursive: true });
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(brainDir));
                    }
                } else {
                    const fileItems = brainFiles.slice(0, 50).map(f => {
                        const rel = path.relative(brainDir, f);
                        let title = '';
                        try { title = fs.readFileSync(f, 'utf-8').split('\n').find(l => l.trim().length > 0)?.replace(/^#+\s*/, '').slice(0, 60) || ''; } catch {}
                        return { label: `📄 ${rel}`, description: title, filePath: f };
                    });
                    const selected = await vscode.window.showQuickPick(fileItems, { 
                        placeHolder: `📂 내 지식 파일 (총 ${fileCount}개) — 클릭하면 내용을 볼 수 있어요` 
                    });
                    if (selected) {
                        const doc = await vscode.workspace.openTextDocument(selected.filePath);
                        vscode.window.showTextDocument(doc);
                    }
                }
                break;
            }
            case 'changeFolder': {
                const folders = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: '이 폴더를 내 지식 폴더로 사용',
                    title: '📁 AI에게 읽혀줄 지식(.md 파일)이 들어있는 폴더를 선택하세요'
                });
                if (folders && folders.length > 0) {
                    const selectedPath = folders[0].fsPath;
                    await vscode.workspace.getConfiguration('connectAiLab').update('localBrainPath', selectedPath, vscode.ConfigurationTarget.Global);
                    this._brainEnabled = true;
                    this._ctx.globalState.update('brainEnabled', true);
                    
                    // 새 폴더에 git이 없으면 자동 초기화 + 기존 깃허브 URL로 remote 재연결
                    const newGitDir = path.join(selectedPath, '.git');
                    if (!fs.existsSync(newGitDir)) {
                        try {
                            gitExec(['init'], selectedPath);
                            gitExecSafe(['branch', '-M', 'main'], selectedPath);

                            const existingRepo = vscode.workspace.getConfiguration('connectAiLab').get<string>('secondBrainRepo', '');
                            const cleanRepo = existingRepo ? validateGitRemoteUrl(existingRepo) : null;
                            if (cleanRepo) {
                                gitExecSafe(['remote', 'add', 'origin', cleanRepo], selectedPath);
                            }
                        } catch (e) {
                            console.warn('Git init on new brain folder failed:', e);
                        }
                    }
                    
                    const newFiles = this._findBrainFiles(selectedPath);
                    vscode.window.showInformationMessage(`✅ 지식 폴더가 변경되었어요! (${newFiles.length}개 지식 파일 발견)`);
                    this._view.webview.postMessage({ type: 'response', value: `🧠 **지식 폴더 연결 완료!**\n📁 ${selectedPath}\n📄 ${newFiles.length}개의 지식 파일을 읽고 있어요.` });
                }
                break;
            }
            case 'resync': {
                this._brainEnabled = true;
                this._ctx.globalState.update('brainEnabled', true);
                const refreshedFiles = this._findBrainFiles(brainDir);
                vscode.window.showInformationMessage(`🔄 지식 새로고침 완료! (${refreshedFiles.length}개)`);
                this._view.webview.postMessage({ type: 'response', value: `🔄 **지식 새로고침 완료!** ${refreshedFiles.length}개 지식이 연결되어 있어요.\n\n지식 모드가 ON 되었습니다.` });
                break;
            }
            case 'viewGraph': {
                vscode.commands.executeCommand('connect-ai-lab.showBrainNetwork');
                break;
            }
            case 'githubSync': {
                await this._syncSecondBrain();
                break;
            }
            case 'changeGithub': {
                const inputUrl = await vscode.window.showInputBox({
                    prompt: '🧠 새로운 깃허브 저장소 주소를 입력하세요',
                    placeHolder: '예: https://github.com/사용자/레포지토리'
                });
                if (inputUrl) {
                    await vscode.workspace.getConfiguration('connectAiLab').update('secondBrainRepo', inputUrl, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`✅ 깃허브 연결 주소가 변경되었습니다! 이제 '깃허브 동기화'를 눌러주세요.`);
                }
                break;
            }
        }
    }

    // --------------------------------------------------------
    // Second Brain (Github Repo Knowledge Sync)
    // --------------------------------------------------------
    private async _syncSecondBrain() {
        if (!this._view) { return; }
        if (this._isSyncingBrain) {
            vscode.window.showWarningMessage('동기화가 이미 진행 중입니다. 잠시만 기다려주세요!');
            return;
        }

        // 폴더 미설정 시 먼저 폴더 선택 강제
        if (!_isBrainDirExplicitlySet()) {
            const ensured = await _ensureBrainDir();
            if (!ensured) { return; }
        }

        let secondBrainRepo = vscode.workspace.getConfiguration('connectAiLab').get<string>('secondBrainRepo', '');
        
        // UX 극대화: 안 채워져 있으면 에러 내뱉지 말고 입력창 띄우기!
        if (!secondBrainRepo) {
            const inputUrl = await vscode.window.showInputBox({
                prompt: '🧠 뇌를 연결할 깃허브 저장소 주소를 입력하세요',
                placeHolder: '예: https://github.com/사용자/레포지토리'
            });
            if (!inputUrl) { return; }
            
            await vscode.workspace.getConfiguration('connectAiLab').update('secondBrainRepo', inputUrl, vscode.ConfigurationTarget.Global);
            secondBrainRepo = inputUrl;
        }

        // git이 시스템에 없으면 의미 있는 에러로 즉시 종료
        if (!isGitAvailable()) {
            this._view.webview.postMessage({ type: 'error', value: '⚠️ git이 설치되지 않았습니다.\n\n👉 https://git-scm.com/downloads 에서 설치 후 VS Code를 다시 실행해주세요.' });
            return;
        }

        // 자동 sync와 동시 실행 방지 (data race로 인한 손상 방지)
        if (_autoSyncRunning) {
            this._view.webview.postMessage({ type: 'response', value: '⏳ 백그라운드에서 자동 동기화가 진행 중입니다. 잠시 후 다시 시도해주세요.' });
            return;
        }
        _autoSyncRunning = true;
        this._isSyncingBrain = true;
        const brainDir = _getBrainDir();
        try {
            this._view.webview.postMessage({ type: 'response', value: '🔄 **지식 동기화 진행 중...** 내 지식 폴더와 GitHub을 최신 상태로 맞추고 있어요.' });

            if (!fs.existsSync(brainDir)) {
                fs.mkdirSync(brainDir, { recursive: true });
            }

            const gitDir = path.join(brainDir, '.git');
            const cleanRepo = validateGitRemoteUrl(secondBrainRepo);
            if (!cleanRepo) {
                throw new Error('지원되지 않는 저장소 URL 형식입니다. 예: https://github.com/사용자/레포지토리');
            }

            // git이 없으면 init
            if (!fs.existsSync(gitDir)) {
                gitExec(['init'], brainDir);
            }

            ensureBrainGitignore(brainDir);
            ensureInitialCommit(brainDir);

            // remote 재연결
            gitExecSafe(['remote', 'remove', 'origin'], brainDir);
            gitExec(['remote', 'add', 'origin', cleanRepo], brainDir);

            // 1. 로컬 변경사항 커밋
            gitExecSafe(['add', '.'], brainDir);
            gitExecSafe(['commit', '-m', 'Auto-sync local brain'], brainDir);

            // 2. 원격 기본 브랜치 감지 + 로컬 브랜치 정렬
            const remoteBranch = getRemoteDefaultBranch(brainDir);
            const currentBranch = gitExecSafe(['rev-parse', '--abbrev-ref', 'HEAD'], brainDir)?.trim() || '';
            if (currentBranch && currentBranch !== remoteBranch) {
                gitExecSafe(['branch', '-M', remoteBranch], brainDir);
            }

            // 3. fetch (원격 상태 파악)
            const fetchRes = gitRun(['fetch', 'origin'], brainDir, 30000);
            const remoteHasBranch = gitExecSafe(['rev-parse', '--verify', `origin/${remoteBranch}`], brainDir) !== null;

            if (fetchRes.status !== 0 && !(fetchRes.stderr || '').toLowerCase().includes("couldn't find remote ref")) {
                const err = classifyGitError(fetchRes.stderr);
                throw new Error(err.message);
            }

            // 4. 원격에 브랜치가 있으면 fast-forward 시도
            if (remoteHasBranch) {
                const ffRes = gitRun(['merge', '--ff-only', `origin/${remoteBranch}`], brainDir, 15000);
                if (ffRes.status !== 0) {
                    const stderrLower = ffRes.stderr.toLowerCase();
                    const diverged = stderrLower.includes('not possible') || stderrLower.includes('non-fast-forward') || stderrLower.includes('refusing');
                    if (diverged) {
                        // 사용자에게 충돌 해결 방법 선택권 제공 (silently 덮어쓰지 않음!)
                        const choice = await vscode.window.showWarningMessage(
                            '⚠️ 로컬과 GitHub에 서로 다른 변경사항이 있습니다. 어떻게 병합할까요?',
                            { modal: true },
                            '🤝 자동 병합 시도 (안전)',
                            '💪 로컬 우선 (GitHub 변경 무시)',
                            '☁️ GitHub 우선 (로컬 변경 무시)'
                        );
                        if (!choice) {
                            this._view.webview.postMessage({ type: 'response', value: '⏸️ 동기화가 취소되었습니다. 로컬 파일은 안전하게 보존되었습니다.' });
                            return;
                        }
                        if (choice.startsWith('🤝')) {
                            const mergeRes = gitRun(['pull', 'origin', remoteBranch, '--no-edit', '--allow-unrelated-histories'], brainDir, 30000);
                            if (mergeRes.status !== 0) {
                                gitExecSafe(['merge', '--abort'], brainDir);
                                throw new Error('자동 병합 실패. 메뉴에서 "로컬 우선" 또는 "GitHub 우선"을 선택해주세요.');
                            }
                        } else if (choice.startsWith('💪')) {
                            gitExec(['pull', 'origin', remoteBranch, '--no-edit', '--allow-unrelated-histories', '-s', 'recursive', '-X', 'ours'], brainDir, 30000);
                        } else {
                            gitExec(['fetch', 'origin', remoteBranch], brainDir, 30000);
                            gitExec(['reset', '--hard', `origin/${remoteBranch}`], brainDir, 15000);
                        }
                    }
                }
            }

            // 5. push (force 없이)
            const pushRes = gitRun(['push', '-u', 'origin', remoteBranch], brainDir, 60000);
            if (pushRes.status !== 0) {
                const err = classifyGitError(pushRes.stderr);
                if (err.kind === 'rejected') {
                    // 충돌이 다시 발생한 경우 — force-push는 사용자 명시적 동의 후에만
                    const force = await vscode.window.showWarningMessage(
                        '⚠️ Push가 거부되었습니다. GitHub에 더 새로운 변경사항이 있을 수 있습니다.\n\n강제로 덮어쓸까요? (GitHub의 새로운 변경사항이 영구 손실됩니다)',
                        { modal: true },
                        '⛔ 취소 (안전)',
                        '⚠️ 강제 덮어쓰기'
                    );
                    if (force === '⚠️ 강제 덮어쓰기') {
                        const forceRes = gitRun(['push', '-u', 'origin', remoteBranch, '--force-with-lease'], brainDir, 60000);
                        if (forceRes.status !== 0) {
                            throw new Error(classifyGitError(forceRes.stderr).message);
                        }
                    } else {
                        throw new Error('동기화가 취소되었습니다. 로컬 파일은 안전합니다.');
                    }
                } else {
                    throw new Error(err.message);
                }
            }

            // 연동 완료 후 자동으로 지식 모드 ON
            this._brainEnabled = true;
            this._ctx.globalState.update('brainEnabled', true);

            vscode.window.showInformationMessage('✅ GitHub과 지식 폴더가 완벽히 동기화되었어요!');
            this._view.webview.postMessage({ type: 'response', value: `✅ **지식 동기화 완료!** (브랜치: \`${remoteBranch}\`)\n\n이제 내 PC와 GitHub이 동일한 최신 상태입니다.\n\n앞으로 답변할 때 이 지식들을 참고합니다. (지식 모드: 🟢 ON)` });
        } catch (error: any) {
            const userMsg = error?.message || '알 수 없는 오류';
            vscode.window.showErrorMessage(`Second Brain 동기화 실패: ${userMsg}`);
            this._view.webview.postMessage({ type: 'error', value: `⚠️ 동기화 실패: ${userMsg}\n\n💡 **자주 발생하는 원인:**\n• Private 저장소인데 Personal Access Token이 설정 안 됨\n• 저장소 URL이 잘못됨 (\`https://github.com/사용자/저장소\` 형식 확인)\n• 네트워크 연결 끊김\n• git이 설치되지 않음\n\n👉 토큰 설정: GitHub Settings → Developer settings → Personal access tokens → Generate new token (repo 권한 부여)` });
        } finally {
            this._isSyncingBrain = false;
            _autoSyncRunning = false;
        }
    }

    // 재귀 탐색 유틸리티 (하위 폴더까지 .md/.txt 파일 긁어옴)
    public _findBrainFiles(dir: string): string[] {
        let results: string[] = [];
        try {
            const list = fs.readdirSync(dir);
            for (const file of list) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    if (file !== '.git' && file !== 'node_modules' && file !== '.obsidian') {
                        results = results.concat(this._findBrainFiles(filePath));
                    }
                } else {
                    if (file.endsWith('.md') || file.endsWith('.txt')) {
                        results.push(filePath);
                    }
                }
            }
        } catch (e) { /* skip unreadable dirs */ }
        return results;
    }

    // 목차(인덱스)만 생성 — 내용은 AI가 <read_brain>으로 직접 열람
    private _getSecondBrainContext(): string {
        const brainDir = _getBrainDir();
        if (!fs.existsSync(brainDir)) return '';

        const files = this._findBrainFiles(brainDir);
        if (files.length === 0) return '';

        // 컨텍스트 폭발 크래시(OOM)를 방지하기 위해 최대 인덱스 개수 제한
        const MAX_INDEX = 200;
        const index: string[] = [];
        let truncated = false;

        for (let i = 0; i < files.length; i++) {
            if (i >= MAX_INDEX) {
                truncated = true;
                break;
            }
            const file = files[i];
            const relativePath = path.relative(brainDir, file);
            try {
                const firstLine = fs.readFileSync(file, 'utf-8').split('\n').find(l => l.trim().length > 0) || '';
                // 제목 부분만 추출 (# 헤더 또는 첫 줄)
                const title = firstLine.replace(/^#+\s*/, '').slice(0, 80);
                index.push(`  📄 ${relativePath}  →  "${title}"`);
            } catch {
                index.push(`  📄 ${relativePath}`);
            }
        }

        const msgLimit = truncated ? `\n(⚠️ 메모리 폭발 방지를 위해 상위 ${MAX_INDEX}개 파일의 목차만 표시됩니다.)` : '';

        return `\n\n[CRITICAL: SECOND BRAIN INDEX — User's Personal Knowledge Base (${files.length} documents)]\nThe user has synced a personal knowledge repository. Below is the TABLE OF CONTENTS.${msgLimit}\nIf the user's query is even slightly related to any topics in this index, YOU MUST FIRST READ the relevant document BEFORE answering.\nTo read the actual content of any document, use EXACTLY this syntax: <read_brain>filename_or_path</read_brain>\nYou can call <read_brain> multiple times. ALWAYS READ THE FULL DOCUMENT BEFORE ANSWERING.\n\n**IMPORTANT: When your answer uses knowledge from the Second Brain, you MUST end your response with a "📚 출처" section listing the file(s) you referenced. Example:\n📚 출처: MrBeast_분석.md, 마케팅_전략.md**\n\n${index.join('\n')}\n\n`;
    }

    // AI가 <read_brain>태그로 요청한 파일의 실제 내용을 읽어서 반환
    private _readBrainFile(filename: string): string {
        const brainDir = _getBrainDir();
        if (!fs.existsSync(brainDir)) return '[ERROR] Second Brain이 동기화되지 않았습니다. 🧠 버튼을 먼저 눌러주세요.';

        // Path traversal 방어: brainDir 밖으로 나가는 경로는 차단
        const exactPath = safeResolveInside(brainDir, filename);
        if (exactPath && fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) {
            const content = fs.readFileSync(exactPath, 'utf-8');
            return content.slice(0, 8000); // 파일당 최대 8000자
        }

        // 파일명만으로 퍼지 검색 (하위 폴더에 있을 수 있으므로)
        const baseOnly = path.basename(filename);
        const allFiles = this._findBrainFiles(brainDir);
        const match = allFiles.find(f =>
            path.basename(f) === baseOnly ||
            path.basename(f) === baseOnly + '.md' ||
            (baseOnly.length > 2 && f.includes(baseOnly))
        );

        if (match) {
            // 결과 파일이 brainDir 안인지 한 번 더 확인
            const resolved = path.resolve(match);
            if (resolved.startsWith(path.resolve(brainDir) + path.sep)) {
                const content = fs.readFileSync(resolved, 'utf-8');
                return content.slice(0, 8000);
            }
        }

        return `[NOT FOUND] "${filename}" 파일을 Second Brain에서 찾을 수 없습니다. 목차(INDEX)를 다시 확인해주세요.`;
    }

    /** 저장된 대화 메시지를 웹뷰에 다시 전송 (복원) */
    private _restoreDisplayMessages() {
        if (!this._view || this._displayMessages.length === 0) { return; }
        this._view.webview.postMessage({
            type: 'restoreMessages',
            value: this._displayMessages
        });
    }

    // --------------------------------------------------------
    // Build workspace file tree + read key files
    // --------------------------------------------------------
    private _getWorkspaceContext(): string {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return ''; }

        // --- 1. File tree ---
        const lines: string[] = [];
        let count = 0;

        const walk = (dir: string, prefix: string) => {
            if (count >= getConfig().maxTreeFiles) { return; }
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch { return; }

            entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) { return -1; }
                if (!a.isDirectory() && b.isDirectory()) { return 1; }
                return a.name.localeCompare(b.name);
            });

            for (const entry of entries) {
                if (count >= getConfig().maxTreeFiles) { break; }
                if (EXCLUDED_DIRS.has(entry.name)) { continue; }
                if (entry.name.startsWith('.') && entry.isDirectory()) { continue; }

                if (entry.isDirectory()) {
                    lines.push(`${prefix}📁 ${entry.name}/`);
                    count++;
                    walk(path.join(dir, entry.name), prefix + '  ');
                } else {
                    lines.push(`${prefix}📄 ${entry.name}`);
                    count++;
                }
            }
        };
        walk(root, '');

        let result = '';
        if (lines.length > 0) {
            result += `\n\n[WORKSPACE INFO]\n📂 경로: ${root}\n\n[프로젝트 파일 구조]\n${lines.join('\n')}`;
        }

        // --- 2. Auto-read key project files ---
        const keyFiles = [
            'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
            'next.config.js', 'next.config.ts', 'README.md',
            'index.html', 'app.js', 'app.ts', 'main.ts', 'main.js',
            'src/index.ts', 'src/index.js', 'src/App.tsx', 'src/App.jsx',
            'src/main.ts', 'src/main.js'
        ];
        let totalRead = 0;
        const MAX_AUTO_READ = 6_000; // chars total

        for (const kf of keyFiles) {
            if (totalRead >= MAX_AUTO_READ) { break; }
            const abs = path.join(root, kf);
            if (fs.existsSync(abs)) {
                try {
                    const content = fs.readFileSync(abs, 'utf-8');
                    if (content.length < 5000) {
                        result += `\n\n[파일 내용: ${kf}]\n\`\`\`\n${content}\n\`\`\``;
                        totalRead += content.length;
                    }
                } catch { /* skip */ }
            }
        }

        return result;
    }

    // --------------------------------------------------------
    // Handle prompt with file attachments (multimodal)
    // --------------------------------------------------------
    private async _handlePromptWithFile(prompt: string, modelName: string, files: {name: string, type: string, data: string}[], internetEnabled?: boolean) {
        if (!this._view) { return; }

        try {
            const { ollamaBase, defaultModel, timeout } = getConfig();
            let isLMStudio = ollamaBase.includes('1234') || ollamaBase.includes('v1');
            let apiUrl = isLMStudio ? `${ollamaBase}/v1/chat/completions` : `${ollamaBase}/api/chat`;

            if (!isLMStudio) {
                try { await axios.get(`${ollamaBase}/api/tags`, { timeout: 1000 }); }
                catch { apiUrl = 'http://127.0.0.1:1234/v1/chat/completions'; isLMStudio = true; }
            }

            // Separate images from text files
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            const textFiles = files.filter(f => !f.type.startsWith('image/'));

            // Build text context from non-image files
            let fileContext = '';
            for (const f of textFiles) {
                // data is base64 encoded, decode to utf-8 text
                const decoded = Buffer.from(f.data, 'base64').toString('utf-8');
                fileContext += `\n\n[첨부 파일: ${f.name}]\n\`\`\`\n${decoded.slice(0, 20000)}\n\`\`\``;
            }

            const userContent = prompt + fileContext;
            this._chatHistory.push({ role: 'user', content: userContent });
            this._displayMessages.push({ text: prompt + (files.length > 0 ? `\n📎 ${files.map(f=>f.name).join(', ')}` : ''), role: 'user' });

            // Build messages
            const reqMessages = [...this._chatHistory];
            if (reqMessages.length > 0 && reqMessages[0].role === 'system') {
                const editor = vscode.window.activeTextEditor;
                let contextBlock = '';
                if (editor && editor.document.uri.scheme === 'file') {
                    const text = editor.document.getText();
                    const name = path.basename(editor.document.fileName);
                    if (text.trim().length > 0 && text.length < MAX_CONTEXT_SIZE) {
                        contextBlock = `\n\n[Currently open file: ${name}]\n\`\`\`\n${text}\n\`\`\``;
                    }
                }
                const workspaceCtx = this._getWorkspaceContext();
                const brainCtx = this._brainEnabled ? this._getSecondBrainContext() : '';
                const internetCtx = internetEnabled 
                    ? `\n\n[CRITICAL DIRECTIVE: INTERNET ACCESS IS ENABLED]\nCurrent Time: ${new Date().toLocaleString('ko-KR')}\nYou have FULL internet access via the <read_url> tool. You MUST NEVER say you cannot search, or that your capabilities are limited. To search, ALWAYS output:\n<read_url>https://html.duckduckgo.com/html/?q=YOUR+SEARCH+TERM</read_url>\nIf the user asks to search, or asks for recent info, DO NOT apologize. Just use the tag.`
                    : '';
                reqMessages[0] = {
                    role: 'system',
                    content: `${this._systemPrompt}\n\n[BACKGROUND CONTEXT]\n${contextBlock}\n${workspaceCtx}\n${brainCtx}${internetCtx}`
                };
            }

            // Build image payload for vision models
            const images = imageFiles.map(f => f.data); // already base64

            let aiMessage = '';
            this._view.webview.postMessage({ type: 'streamStart' });

            if (isLMStudio) {
                // OpenAI-compatible format with image_url
                const lastUserMsg = reqMessages[reqMessages.length - 1];
                const contentParts: any[] = [{ type: 'text', text: lastUserMsg.content }];
                for (const img of images) {
                    contentParts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } });
                }
                reqMessages[reqMessages.length - 1] = { role: 'user', content: contentParts as any };

                const streamBody = {
                    model: modelName || defaultModel,
                    messages: reqMessages,
                    stream: true,
                    max_tokens: 4096, temperature: this._temperature, top_p: this._topP
                };
                const response = await axios.post(apiUrl, streamBody, { timeout, responseType: 'stream' });
                await new Promise<void>((resolve, reject) => {
                    const stream = response.data;
                    let buffer = '';
                    stream.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        if (buffer.length > MAX_STREAM_BUFFER) {
                            // Buffer가 비정상적으로 커짐 → 라인 구분자가 없는 응답일 수 있음. 강제로 자른다.
                            buffer = buffer.slice(-MAX_STREAM_BUFFER);
                        }
                        const lines = buffer.split('\n'); buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (!line.trim() || line.trim() === 'data: [DONE]') continue;
                            try {
                                const raw = line.startsWith('data: ') ? line.slice(6) : line;
                                const json = JSON.parse(raw);
                                let token = json.choices?.[0]?.delta?.content || '';
                                if (json.error) {
                                    token = `[API 오류] ${json.error.message || json.error}`;
                                }
                                if (token) { aiMessage += token; this._view!.webview.postMessage({ type: 'streamChunk', value: token }); }
                            } catch { /* malformed JSON line, skip */ }
                        }
                    });
                    stream.on('end', () => resolve());
                    stream.on('error', (err: any) => reject(err));
                });
            } else {
                // Ollama native format with images array
                const streamBody: any = {
                    model: modelName || defaultModel,
                    messages: reqMessages,
                    stream: true,
                    options: { num_ctx: 16384, num_predict: 4096, temperature: this._temperature, top_p: this._topP, top_k: this._topK }
                };
                // Attach images to the last user message for Ollama
                if (images.length > 0) {
                    streamBody.messages = reqMessages.map((m: any, i: number) => 
                        i === reqMessages.length - 1 ? { ...m, images } : m
                    );
                }
                const response = await axios.post(apiUrl, streamBody, { timeout, responseType: 'stream' });
                await new Promise<void>((resolve, reject) => {
                    const stream = response.data;
                    let buffer = '';
                    stream.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        if (buffer.length > MAX_STREAM_BUFFER) buffer = buffer.slice(-MAX_STREAM_BUFFER);
                        const lines = buffer.split('\n'); buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const json = JSON.parse(line);
                                let token = json.message?.content || '';
                                if (json.error) {
                                    token = `[API 오류] ${json.error}`;
                                }
                                if (token) { aiMessage += token; this._view!.webview.postMessage({ type: 'streamChunk', value: token }); }
                            } catch { /* malformed JSON line, skip */ }
                        }
                    });
                    stream.on('end', () => resolve());
                    stream.on('error', (err: any) => reject(err));
                });
            }

            this._view.webview.postMessage({ type: 'streamEnd' });
            this._chatHistory.push({ role: 'assistant', content: aiMessage });

            const report = await this._executeActions(aiMessage);
            if (report.length > 0) {
                const reportMsg = `\n\n---\n**에이전트 작업 결과**\n${report.join('\n')}`;
                this._view.webview.postMessage({ type: 'streamChunk', value: reportMsg });
                this._view.webview.postMessage({ type: 'streamEnd' });
                aiMessage += reportMsg;
            }
            this._displayMessages.push({ text: this._stripActionTags(aiMessage), role: 'ai' });
            this._pruneHistory();
            this._saveHistory();

        } catch (error: any) {
            const { ollamaBase } = getConfig();
            const isLM = ollamaBase.includes('1234') || ollamaBase.includes('v1');
            const targetName = isLM ? "LM Studio" : "Ollama";

            let errMsg = '';
            if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
                errMsg = `⚠️ ${targetName}에 연결할 수 없어요.\n\n**확인할 점:**\n• ${targetName} 앱이 켜져 있나요? (Start Server 클릭)\n• 포트가 ${isLM ? '1234' : '11434'} 맞나요? (설정 > Ollama URL)`;
            } else if (error.response?.status === 400) {
                errMsg = `⚠️ AI가 요청을 이해하지 못했어요.\n\n**해결 방법:**\n• 헤더의 모델 선택 드롭다운에서 다른 모델을 골라보세요\n${isLM ? '• LM Studio에서 모델을 먼저 로드(Load)했는지 확인하세요' : '• 터미널에서 `ollama list`로 설치된 모델을 확인하세요'}`;
            } else if (error.response?.status === 404) {
                errMsg = `⚠️ 선택한 모델을 찾을 수 없어요.\n\n**해결 방법:**\n${isLM ? '• LM Studio에서 모델을 다운로드 후 로드(Load)하세요' : '• 터미널에서 `ollama pull 모델이름`으로 먼저 받아주세요'}`;
            } else if (error.response?.status === 413) {
                errMsg = `⚠️ 대화가 너무 길어졌어요.\n\n**해결 방법:**\n• 헤더의 + 버튼으로 새 대화를 시작하세요\n• 또는 🧠 지식 모드를 일시 OFF\n${isLM ? '• 또는 LM Studio에서 모델 로드 시 Context Length를 8192 이상으로 늘려주세요' : ''}`;
            } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
                errMsg = `⚠️ AI 응답이 너무 오래 걸려요.\n\n**해결 방법:**\n• 더 작은 모델로 바꿔보세요 (예: 7B → 3B)\n• 질문을 짧게 줄여보세요\n• 설정에서 Request Timeout을 늘려보세요`;
            } else {
                errMsg = `⚠️ 오류: ${error.message}`;
            }

            this._view.webview.postMessage({ type: 'error', value: errMsg });

            // Axios의 타입이 stream일 때 에러 본문을 파싱해서 원인을 명확히 로그에 남김
            if (error.response?.data?.on) {
                let buf = '';
                error.response.data.on('data', (c: any) => buf += c.toString());
                error.response.data.on('end', () => {
                    try {
                        const parsed = JSON.parse(buf);
                        if (parsed.error?.message) {
                            this._view!.webview.postMessage({ type: 'error', value: `⚠️ API 자세한 오류: ${parsed.error.message}` });
                        }
                    } catch { /* ignore parsing err */ }
                });
            }
        }
    }

    // --------------------------------------------------------
    // Handle user prompt → Ollama → agent actions → response
    // --------------------------------------------------------
    private async _handlePrompt(prompt: string, modelName: string, internetEnabled?: boolean) {
        if (!this._view) { return; }

        try {
            // 1. Context: active editor content
            const editor = vscode.window.activeTextEditor;
            let contextBlock = '';
            if (editor && editor.document.uri.scheme === 'file') {
                const text = editor.document.getText();
                const name = path.basename(editor.document.fileName);
                if (text.trim().length > 0 && text.length < MAX_CONTEXT_SIZE) {
                    contextBlock = `\n\n[Currently open file: ${name}]\n\`\`\`\n${text}\n\`\`\``;
                }
            }

            // 2. Context: workspace file tree + key file contents
            const workspaceCtx = this._getWorkspaceContext();
            
            // 2.5 Inject Second Brain Knowledge (ON/OFF 토글 반영)
            const brainCtx = this._brainEnabled ? this._getSecondBrainContext() : '';

            // 3. Push user message
            this._chatHistory.push({
                role: 'user',
                content: prompt
            });

            // 저장용: 유저 메시지 기록 (프롬프트만)
            this._displayMessages.push({ text: prompt, role: 'user' });

            // 4. Call Ollama
            const { ollamaBase, defaultModel, timeout } = getConfig();

            // 이번 요청에만 사용할 임시 메시지 배열 생성
            const reqMessages = [...this._chatHistory];
            // 시스템 프롬프트(0번 인덱스)에 현재 작업 환경 정보를 주입
            if (reqMessages.length > 0 && reqMessages[0].role === 'system') {
                const internetCtx = internetEnabled 
                    ? `\n\n[CRITICAL DIRECTIVE: INTERNET ACCESS IS ENABLED]\nCurrent Time: ${new Date().toLocaleString('ko-KR')}\nYou have FULL internet access via the <read_url> tool. You MUST NEVER say you cannot search, or that your capabilities are limited. To search, ALWAYS output:\n<read_url>https://html.duckduckgo.com/html/?q=YOUR+SEARCH+TERM</read_url>\nIf the user asks to search, or asks for recent info, DO NOT apologize. Just use the tag.`
                    : '';
                reqMessages[0] = {
                    role: 'system',
                    content: `${SYSTEM_PROMPT}\n\n[BACKGROUND CONTEXT - DO NOT EXPLAIN THIS TO THE USER UNLESS ASKED]\n${contextBlock}\n${workspaceCtx}\n${brainCtx}${internetCtx}`
                };
            }

            let isLMStudio = ollamaBase.includes('1234') || ollamaBase.includes('v1');
            let apiUrl = isLMStudio ? `${ollamaBase}/v1/chat/completions` : `${ollamaBase}/api/chat`;

            // Auto-Failover Logic: 유저가 설정을 안 건드렸더라도 Ollama가 죽어있으면 자동으로 LM Studio를 찾아갑니다!
            if (!isLMStudio) {
                try {
                    await axios.get(`${ollamaBase}/api/tags`, { timeout: 1000 });
                } catch (err: any) {
                    // Ollama 연결 실패 시 LM Studio 1234 포트로 강제 우회
                    apiUrl = 'http://127.0.0.1:1234/v1/chat/completions';
                    isLMStudio = true;
                }
            }

            // ═══ STREAMING API CALL ═══
            let aiMessage = '';
            const streamBody = {
                model: modelName || defaultModel,
                messages: reqMessages,
                stream: true,
                ...(isLMStudio 
                    ? { max_tokens: 4096, temperature: this._temperature, top_p: this._topP } 
                    : { options: { num_ctx: 16384, num_predict: 4096, temperature: this._temperature, top_p: this._topP, top_k: this._topK } }),
            };

            // 스트리밍: 웹뷰에 'streamStart' 로 빈 메시지 생성 후 'streamChunk'로 실시간 업데이트
            this._view.webview.postMessage({ type: 'streamStart' });
            this._lastPrompt = prompt;
            this._lastModel = modelName;
            this._abortController = new AbortController();

            const response = await axios.post(apiUrl, streamBody, { 
                timeout, 
                responseType: 'stream',
                signal: this._abortController.signal
            });

            await new Promise<void>((resolve, reject) => {
                const stream = response.data;
                let buffer = '';
                stream.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    if (buffer.length > MAX_STREAM_BUFFER) buffer = buffer.slice(-MAX_STREAM_BUFFER);
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.trim() || line.trim() === 'data: [DONE]') continue;
                        try {
                            const raw = line.startsWith('data: ') ? line.slice(6) : line;
                            const json = JSON.parse(raw);
                            let token = '';
                            if (json.error) {
                                token = `[API 오류] ${json.error.message || json.error}`;
                            } else if (isLMStudio) {
                                token = json.choices?.[0]?.delta?.content || '';
                            } else {
                                token = json.message?.content || '';
                            }
                            if (token) {
                                aiMessage += token;
                                this._view!.webview.postMessage({ type: 'streamChunk', value: token });
                            }
                        } catch { /* skip malformed JSON */ }
                    }
                });
                stream.on('end', () => resolve());
                stream.on('error', (err: any) => reject(err));
            });

            // 스트리밍 완료 알림 잠시 보류 (연속된 답변을 같은 상자에 이어서 출력하기 위함)
            
            // 4.5 자율 열람 (Second Brain 및 웹 검색): AI가 <read_brain> 또는 <read_url>을 사용했는지 확인
            const brainReads = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)];
            const urlReads = [...aiMessage.matchAll(/<read_url>([\s\S]*?)<\/read_url>/gi)];

            if (brainReads.length > 0 || urlReads.length > 0) {
                let fetchedContent = '';
                let uiFeedbackStr = '';
                
                // Brain 읽기 처리
                for (const match of brainReads) {
                    const requestedFile = match[1].trim();
                    const fileContent = this._readBrainFile(requestedFile);
                    fetchedContent += `\n\n[BRAIN DOCUMENT: ${requestedFile}]\n${fileContent}\n`;
                }

                // URL 읽기 처리
                for (const match of urlReads) {
                    const url = match[1].trim();
                    try {
                        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                        let cleaned = data.toString()
                            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        fetchedContent += `\n\n[WEB CONTENT: ${url}]\n${cleaned.slice(0, 15000)}\n`;
                        const msg = `\n\n> 🌐 **[웹 검색 완료]** ${url} (${cleaned.length}자)\n\n`;
                        uiFeedbackStr += msg;
                        this._view.webview.postMessage({ type: 'streamChunk', value: msg });
                    } catch (err: any) {
                        fetchedContent += `\n\n[WEB CONTENT: ${url}] (FAILED: ${err.message})\n`;
                        const msg = `\n\n> 🌐 **[웹 검색 실패]** ${url} - ${err.message}\n\n`;
                        uiFeedbackStr += msg;
                        this._view.webview.postMessage({ type: 'streamChunk', value: msg });
                    }
                }

                const cleanedResponse = aiMessage.replace(/<read_brain>[\s\S]*?<\/read_brain>/g, '')
                                                 .replace(/<read_url>[\s\S]*?<\/read_url>/gi, '').trim();
                
                if (brainReads.length > 0) {
                    const msg = `\n\n> 🧠 **[Second Brain 열람 완료]** 스캔한 핵심 지식을 바탕으로 답변을 구성합니다...\n\n`;
                    uiFeedbackStr += msg;
                    this._view.webview.postMessage({ type: 'streamChunk', value: msg });
                }
                
                reqMessages.push({ role: 'assistant', content: cleanedResponse || '탐색을 진행 중입니다...' });
                reqMessages.push({ role: 'user', content: `[SYSTEM: The following documents and web contents were retrieved based on your actions. Use this information to provide a complete and accurate answer to the user's original question.]\n${fetchedContent}\n\nNow answer the user's question using the above knowledge. Do NOT output <read_brain> or <read_url> again. Answer directly and comprehensively.` });

                // 2차 스트리밍 시작 (followUp)
                const followUpResponse = await axios.post(apiUrl, {
                    model: modelName || defaultModel,
                    messages: reqMessages,
                    stream: true, // 스트리밍 활성화
                    ...(isLMStudio 
                        ? { max_tokens: 4096, temperature: this._temperature, top_p: this._topP } 
                        : { options: { num_ctx: 16384, num_predict: 4096, temperature: this._temperature, top_p: this._topP, top_k: this._topK } }),
                }, { timeout, responseType: 'stream', signal: this._abortController?.signal });

                aiMessage = cleanedResponse + uiFeedbackStr;
                
                await new Promise<void>((resolve, reject) => {
                    const stream = followUpResponse.data;
                    let buffer = '';
                    stream.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        if (buffer.length > MAX_STREAM_BUFFER) buffer = buffer.slice(-MAX_STREAM_BUFFER);
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (!line.trim() || line.trim() === 'data: [DONE]') continue;
                            try {
                                const raw = line.startsWith('data: ') ? line.slice(6) : line;
                                const json = JSON.parse(raw);
                                let token = '';
                                if (json.error) token = `[API 오류] ${json.error.message || json.error}`;
                                else if (isLMStudio) token = json.choices?.[0]?.delta?.content || '';
                                else token = json.message?.content || '';

                                if (token) {
                                    aiMessage += token;
                                    this._view!.webview.postMessage({ type: 'streamChunk', value: token });
                                }
                            } catch { /* skip */ }
                        }
                    });
                    stream.on('end', () => resolve());
                    stream.on('error', (err: any) => reject(err));
                });
            }

            // 모든 스트리밍(1차 및 2차)이 끝난 후, 박스 포장 완료
            this._view.webview.postMessage({ type: 'streamEnd' });

            this._chatHistory.push({ role: 'assistant', content: aiMessage });

            // 5. Execute agent actions
            const report = await this._executeActions(aiMessage);

            // 6. Agent report 추가 (있을 때만)
            if (report.length > 0) {
                const reportMsg = `\n\n---\n**에이전트 작업 결과**\n${report.join('\n')}`;
                this._view.webview.postMessage({ type: 'streamChunk', value: reportMsg });
                this._view.webview.postMessage({ type: 'streamEnd' });
                aiMessage += reportMsg;
            }

            // 저장용: AI 응답 기록
            this._displayMessages.push({ text: this._stripActionTags(aiMessage), role: 'ai' });

            this._pruneHistory();
            this._saveHistory();

        } catch (error: any) {
            const { ollamaBase } = getConfig();
            const isLM = ollamaBase.includes('1234') || ollamaBase.includes('v1');
            const targetName = isLM ? "LM Studio" : "Ollama";
            
            let errMsg: string;
            if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
                errMsg = `⚠️ ${targetName}에 연결할 수 없어요.\n앱이 켜져 있고 Start Server가 눌러져 있는지 확인해주세요.`;
            } else if (error.response?.status === 413) {
                errMsg = `⚠️ 대화가 너무 길어졌어요.\n• 헤더의 + 버튼으로 새 대화를 시작하세요\n${isLM ? '• 또는 LM Studio에서 모델 로드 시 Context Length를 8192 이상으로 늘려주세요' : ''}`;
            } else if (error.response?.status === 400) {
                errMsg = `⚠️ AI가 요청을 이해하지 못했어요. 다른 모델을 선택해보거나, 질문을 짧게 줄여보세요.`;
            } else {
                errMsg = `⚠️ 오류: ${error.message}`;
            }
            
            this._view.webview.postMessage({ type: 'error', value: errMsg });

            // 파싱된 실제 에러 표출 (LM Studio / Ollama Stream HTTP 에러)
            if (error.response?.data?.on) {
                let buf = '';
                error.response.data.on('data', (c: any) => buf += c.toString());
                error.response.data.on('end', () => {
                    try {
                        const parsed = JSON.parse(buf);
                        let detail = parsed.error?.message || parsed.error || '';
                        if (detail.includes('greater than the context length')) {
                            detail = '프로젝트 정보가 모델의 기억 용량(Context Length)을 초과했어요.\n💡 LM Studio에서 모델을 다시 로드할 때, 오른쪽 패널의 [Context Length] 슬라이더를 8192 이상으로 올려주세요.';
                        }
                        if (detail) {
                            this._view!.webview.postMessage({ type: 'error', value: `💡 가이드: ${detail}` });
                        }
                    } catch { /* ignore */ }
                });
            }
        }
    }

    // --------------------------------------------------------
    // Execute ALL agent actions from AI response
    // --------------------------------------------------------
    private async _executeActions(aiMessage: string): Promise<string[]> {
        const report: string[] = [];
        let brainModified = false;
        let rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        // Fallback to active editor directory if no workspace folder is open
        if (!rootPath && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
            rootPath = path.dirname(vscode.window.activeTextEditor.document.uri.fsPath);
        }

        if (!rootPath) {
            const hasActions = /<(?:create_file|edit_file|run_command|delete_file|read_file|list_files|file)/i.test(aiMessage);
            if (hasActions) {
                report.push('❌ 폴더가 열려있지 않습니다. File → Open Folder로 폴더를 열거나 파일을 열어주세요.');
            }
            return report;
        }

        // ACTION 1: Create files
        const createRegex = /<(?:create_file|file)\s+(?:path|file|name)=['"]?([^'">]+)['"]?[^>]*>([\s\S]*?)<\/(?:create_file|file)>/gi;
        let match: RegExpExecArray | null;
        let firstCreatedFile = '';

        while ((match = createRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            let content = match[2].trim();

            // Strip markdown code fences if AI accidentally wrapped the content inside the xml
            if (content.startsWith('```')) {
                const lines = content.split('\n');
                if (lines[0].startsWith('```')) lines.shift();
                if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) lines.pop();
                content = lines.join('\n').trim();
            }

            const absPath = safeResolveInside(rootPath, relPath);
            if (!absPath) {
                report.push(`❌ 생성 차단: ${relPath} — 워크스페이스 밖으로 나가는 경로입니다.`);
                continue;
            }
            try {
                const dir = path.dirname(absPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(absPath, content, 'utf-8');
                if (absPath.startsWith(_getBrainDir())) brainModified = true;
                report.push(`✅ 생성: ${relPath}`);
                if (!firstCreatedFile) { firstCreatedFile = absPath; }
            } catch (err: any) {
                report.push(`❌ 생성 실패: ${relPath} — ${err.message}`);
            }
        }

        // Open first created file
        if (firstCreatedFile) {
            await vscode.window.showTextDocument(vscode.Uri.file(firstCreatedFile), { preview: false });
        }

        // ACTION 2: Edit files
        const editRegex = /<(?:edit_file|edit)\s+(?:path|file|name)=['"]?([^'">]+)['"]?[^>]*>([\s\S]*?)<\/(?:edit_file|edit)>/gi;
        while ((match = editRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const body = match[2];
            const absPath = safeResolveInside(rootPath, relPath);
            if (!absPath) {
                report.push(`❌ 편집 차단: ${relPath} — 워크스페이스 밖으로 나가는 경로입니다.`);
                continue;
            }

            try {
                let fileContent = fs.readFileSync(absPath, 'utf-8');
                const findReplaceRegex = /<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>/g;
                let frMatch: RegExpExecArray | null;
                let editCount = 0;

                while ((frMatch = findReplaceRegex.exec(body)) !== null) {
                    const findText = frMatch[1];
                    const replaceText = frMatch[2];
                    if (fileContent.includes(findText)) {
                        fileContent = fileContent.replace(findText, replaceText);
                        editCount++;
                    } else {
                        report.push(`⚠️ ${relPath}: 일치하는 텍스트를 찾지 못했습니다.`);
                    }
                }

                if (editCount > 0) {
                    fs.writeFileSync(absPath, fileContent, 'utf-8');
                    if (absPath.startsWith(_getBrainDir())) brainModified = true;
                    report.push(`✏️ 편집 완료: ${relPath} (${editCount}건 수정)`);
                    // Open edited file
                    await vscode.window.showTextDocument(vscode.Uri.file(absPath), { preview: false });
                }
            } catch (err: any) {
                if (err.code === 'ENOENT') {
                    report.push(`❌ 편집 실패: ${relPath} — 파일이 존재하지 않습니다.`);
                } else {
                    report.push(`❌ 편집 실패: ${relPath} — ${err.message}`);
                }
            }
        }

        // ACTION 3: Delete files
        const deleteRegex = /<(?:delete_file|delete)\s+(?:path|file|name)=['"]?([^'"\/\>]+)['"]?\s*\/?>(?:<\/(?:delete_file|delete)>)?/gi;
        while ((match = deleteRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const absPath = safeResolveInside(rootPath, relPath);
            if (!absPath) {
                report.push(`❌ 삭제 차단: ${relPath} — 워크스페이스 밖으로 나가는 경로입니다.`);
                continue;
            }
            try {
                if (fs.existsSync(absPath)) {
                    const stat = fs.statSync(absPath);
                    if (stat.isDirectory()) {
                        fs.rmSync(absPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(absPath);
                    }
                    if (absPath.startsWith(_getBrainDir())) brainModified = true;
                    report.push(`🗑️ 삭제: ${relPath}`);
                } else {
                    report.push(`⚠️ 삭제 스킵: ${relPath} — 파일이 존재하지 않습니다.`);
                }
            } catch (err: any) {
                report.push(`❌ 삭제 실패: ${relPath} — ${err.message}`);
            }
        }

        // ACTION 4: Read files — inject content back into chat history + show preview
        const readRegex = /<(?:read_file|read)\s+(?:path|file|name)=['"]?([^'">]+)['"]?\s*\/?>(?:<\/(?:read_file|read)>)?/gi;
        while ((match = readRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const absPath = safeResolveInside(rootPath, relPath);
            if (!absPath) {
                report.push(`❌ 읽기 차단: ${relPath} — 워크스페이스 밖으로 나가는 경로입니다.`);
                continue;
            }
            try {
                if (fs.existsSync(absPath)) {
                    const content = fs.readFileSync(absPath, 'utf-8');
                    const preview = content.slice(0, 500).split('\n').slice(0, 10).join('\n');
                    report.push(`📖 읽기: ${relPath} (${content.length}자)\n\`\`\`\n${preview}...\n\`\`\``);
                    this._chatHistory.push({ role: 'user', content: `[시스템: read_file 결과]\n파일: ${relPath}\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\`` });
                } else {
                    report.push(`⚠️ 읽기 실패: ${relPath} — 파일이 존재하지 않습니다.`);
                }
            } catch (err: any) {
                report.push(`❌ 읽기 실패: ${relPath} — ${err.message}`);
            }
        }

        // ACTION 5: List directory
        const listRegex = /<(?:list_files|list_dir|ls)\s+(?:path|dir|name)=['"]?([^'"\/\>]*)['"]?\s*\/?>(?:<\/(?:list_files|list_dir|ls)>)?/gi;
        while ((match = listRegex.exec(aiMessage)) !== null) {
            const relDir = match[1].trim() || '.';
            const absDir = safeResolveInside(rootPath, relDir);
            if (!absDir) {
                report.push(`❌ 목록 차단: ${relDir} — 워크스페이스 밖으로 나가는 경로입니다.`);
                continue;
            }
            try {
                if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
                    const entries = fs.readdirSync(absDir, { withFileTypes: true });
                    const listing = entries
                        .filter(e => !e.name.startsWith('.') && !EXCLUDED_DIRS.has(e.name))
                        .map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)
                        .join('\n');
                    report.push(`📂 목록: ${relDir}/\n\`\`\`\n${listing}\n\`\`\``);
                    this._chatHistory.push({ role: 'user', content: `[시스템: list_files 결과]\n디렉토리: ${relDir}/\n${listing}` });
                } else {
                    report.push(`⚠️ 목록 실패: ${relDir} — 디렉토리가 존재하지 않습니다.`);
                }
            } catch (err: any) {
                report.push(`❌ 목록 실패: ${relDir} — ${err.message}`);
            }
        }

        // ACTION 6: Run commands
        const cmdRegex = /<(?:run_command|command|bash|terminal)>([\s\S]*?)<\/(?:run_command|command|bash|terminal)>/gi;
        while ((match = cmdRegex.exec(aiMessage)) !== null) {
            let cmd = match[1].trim();
            // Clean up if AI outputs markdown inside
            if (cmd.startsWith('```')) {
                const lines = cmd.split('\n');
                if (lines[0].startsWith('```')) lines.shift();
                if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) lines.pop();
                cmd = lines.join('\n').trim();
            }
            try {
                if (!this._terminal || this._terminal.exitStatus !== undefined) {
                    this._terminal = vscode.window.createTerminal({
                        name: '🚀 Connect AI',
                        cwd: rootPath
                    });
                }
                this._terminal.show();
                this._terminal.sendText(cmd);
                report.push(`🖥️ 실행: ${cmd}`);
            } catch (err: any) {
                report.push(`❌ 명령 실패: ${cmd} — ${err.message}`);
            }
        }

        // ACTION 8: Read Urls (Web Scraping)
        const urlRegex = /<(?:read_url|url|fetch_url)>([\s\S]*?)<\/(?:read_url|url|fetch_url)>/gi;
        while ((match = urlRegex.exec(aiMessage)) !== null) {
            const url = match[1].trim();
            try {
                // Fetch the HTML content
                const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
                // Strip scripts and styles first
                let cleaned = data.toString()
                    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                    // Strip remaining HTML tags
                    .replace(/<[^>]+>/g, ' ')
                    // Consolidate whitespaces
                    .replace(/\s+/g, ' ')
                    .trim();
                
                const preview = cleaned.slice(0, 500);
                report.push(`🌐 웹사이트 읽기: ${url} (${cleaned.length}자)\n\`\`\`\n${preview}...\n\`\`\``);
                this._chatHistory.push({ role: 'user', content: `[시스템: read_url 결과]\nURL: ${url}\n\`\`\`\n${cleaned.slice(0, 15000)}\n\`\`\`` });
            } catch (err: any) {
                report.push(`❌ 웹사이트 접속 실패: ${url} — ${err.message}`);
                this._chatHistory.push({ role: 'user', content: `[시스템: read_url 실패]\n${err.message}` });
            }
        }

        // FALLBACK: If AI used markdown code blocks with filenames instead of XML tags
        if (report.length === 0) {
            const fallbackRegex = /```(?:[a-zA-Z]*)?\s*\n\/\/\s*(?:file|파일):\s*([^\n]+)\n([\s\S]*?)```/gi;
            while ((match = fallbackRegex.exec(aiMessage)) !== null) {
                const relPath = match[1].trim();
                const content = match[2].trim();
                if (relPath && content && relPath.includes('.')) {
                    const absPath = safeResolveInside(rootPath, relPath);
                    if (!absPath) {
                        report.push(`❌ 생성 차단: ${relPath} — 워크스페이스 밖으로 나가는 경로입니다.`);
                        continue;
                    }
                    try {
                        const dir = path.dirname(absPath);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(absPath, content, 'utf-8');
                        report.push(`✅ 생성(자동감지): ${relPath}`);
                        if (!firstCreatedFile) firstCreatedFile = absPath;
                    } catch (err: any) {
                        report.push(`❌ 생성 실패: ${relPath} — ${err.message}`);
                    }
                }
            }
            if (firstCreatedFile) {
                await vscode.window.showTextDocument(vscode.Uri.file(firstCreatedFile), { preview: false });
            }
        }

        // Show notification
        const successCount = report.filter(r => r.startsWith('✅') || r.startsWith('✏️') || r.startsWith('🖥️') || r.startsWith('🗑️') || r.startsWith('📖') || r.startsWith('📂')).length;
        if (successCount > 0) {
            vscode.window.showInformationMessage(`Connect AI: ${successCount}개 에이전트 작업 완료!`);
        }

        // Auto-Push Second Brain changes to Cloud
        if (brainModified) {
            _safeGitAutoSync(_getBrainDir(), `[P-Reinforce] Auto-synced structured knowledge`, this);
        }

        return report;
    }

    // Strip raw XML action tags from display message
    private _stripActionTags(text: string): string {
        return text
            .replace(/<(?:create_file|file)\s+[^>]*>[\s\S]*?<\/(?:create_file|file)>/gi, '')
            .replace(/<(?:edit_file|edit)\s+[^>]*>[\s\S]*?<\/(?:edit_file|edit)>/gi, '')
            .replace(/<(?:delete_file|delete)\s+[^>]*\s*\/?>(?:<\/(?:delete_file|delete)>)?/gi, '')
            .replace(/<(?:read_file|read)\s+[^>]*\s*\/?>(?:<\/(?:read_file|read)>)?/gi, '')
            .replace(/<(?:list_files|list_dir|ls)\s+[^>]*\s*\/?>(?:<\/(?:list_files|list_dir|ls)>)?/gi, '')
            .replace(/<(?:run_command|command|bash|terminal)>[\s\S]*?<\/(?:run_command|command|bash|terminal)>/gi, '')
            .replace(/<(?:read_brain)>[\s\S]*?<\/(?:read_brain)>/gi, '')
            .trim();
    }


    // ============================================================
    // Webview HTML — CINEMATIC UI v3 (Content-Grade Visuals)
    // ============================================================
    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Connect AI</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#000000;--bg2:#050505;--surface:rgba(0,18,5,.75);--surface2:rgba(0,35,10,.6);
  --border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.12);
  --text:#A1A1AA;--text-bright:#FFFFFF;--text-dim:#71717A;
  --accent:#00FF41;--accent2:#008F11;--accent3:#00FF41;
  --accent-glow:rgba(0,255,65,.25);--accent2-glow:rgba(0,143,17,.2);
  --input-bg:rgba(0,10,2,.9);--code-bg:#020502;
  --green:#00FF41;--yellow:#ffab40;--cyan:#00e5ff;--red:#ff5252;
}
body.vscode-light {
  --bg:#fafafa;--bg2:#ffffff;--surface:rgba(255,255,255,.8);--surface2:rgba(240,240,245,.8);
  --border:rgba(0,0,0,.08);--border2:rgba(0,0,0,.15);
  --text:#454555;--text-bright:#111118;--text-dim:#888899;
  --accent-glow:rgba(124,106,255,.1);--accent2-glow:rgba(224,64,251,.08);
  --input-bg:rgba(255,255,255,.9);--code-bg:#f5f5f7;
}
html,body{height:100%;font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:13px;background:var(--bg);color:var(--text);display:flex;flex-direction:column;overflow:hidden;min-height:0}

/* AURORA BACKGROUND */
body::before{content:'';position:fixed;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(ellipse at 20% 50%,rgba(124,106,255,.06) 0%,transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(224,64,251,.04) 0%,transparent 50%),radial-gradient(ellipse at 50% 80%,rgba(0,229,255,.03) 0%,transparent 50%);animation:aurora 20s ease-in-out infinite;z-index:0;pointer-events:none}
@keyframes aurora{0%,100%{transform:translate(0,0) rotate(0deg)}33%{transform:translate(2%,-1%) rotate(.5deg)}66%{transform:translate(-1%,2%) rotate(-.5deg)}}

/* HEADER */
.header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(10,10,12,.8);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border);flex-shrink:0;position:relative;z-index:10}
.header::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent 5%,var(--accent) 30%,var(--accent2) 50%,var(--accent3) 70%,transparent 95%);opacity:.5;animation:headerGlow 4s ease-in-out infinite alternate}
@keyframes headerGlow{0%{opacity:.3}100%{opacity:.6}}
.thinking-bar{height:2px;background:transparent;position:relative;overflow:hidden;flex-shrink:0;z-index:10}
.thinking-bar.active{background:rgba(124,106,255,.1)}
.thinking-bar.active::after{content:'';position:absolute;top:0;left:-40%;width:40%;height:100%;background:linear-gradient(90deg,transparent,var(--accent),var(--accent2),var(--accent3),transparent);animation:thinkSlide 1.5s ease-in-out infinite}
@keyframes thinkSlide{0%{left:-40%}100%{left:100%}}
.header-left{display:flex;align-items:center;gap:8px}
.logo{width:26px;height:26px;border-radius:6px;background:#050505;border:1px solid rgba(0,255,65,.3);display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--accent);box-shadow:0 0 15px rgba(0,255,65,.15);animation:logoPulse 3s ease-in-out infinite;position:relative;text-shadow:0 0 8px var(--accent)}
.logo::after{content:'';position:absolute;inset:-1px;border-radius:7px;background:var(--accent);opacity:.2;filter:blur(3px);animation:logoPulse 3s ease-in-out infinite}
@keyframes logoPulse{0%,100%{box-shadow:0 0 10px rgba(0,255,65,.1)}50%{box-shadow:0 0 25px rgba(0,255,65,.3)}}
.brand{font-weight:800;font-size:14px;color:var(--text-bright);letter-spacing:-.5px;background:linear-gradient(135deg,#fff 40%,var(--accent) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header-right{display:flex;align-items:center;gap:5px}
select{background:rgba(22,22,28,.9);color:var(--text-bright);border:1px solid var(--border2);padding:5px 8px;border-radius:8px;font-size:10px;font-family:inherit;cursor:pointer;outline:none;max-width:120px;transition:all .3s;backdrop-filter:blur(8px)}
select:hover,select:focus{border-color:var(--accent);box-shadow:0 0 12px var(--accent-glow)}
.btn-icon{background:rgba(22,22,28,.7);border:1px solid var(--border2);color:var(--text-dim);width:28px;height:28px;border-radius:8px;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .3s;backdrop-filter:blur(8px);position:relative;overflow:hidden}
.btn-icon::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,var(--accent-glow),var(--accent2-glow));opacity:0;transition:opacity .3s}
.btn-icon:hover{color:var(--text-bright);border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 15px var(--accent-glow)}
.btn-icon:hover::before{opacity:1}

/* CHAT */
.chat{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:16px;position:relative;z-index:1;min-height:0}
.chat::-webkit-scrollbar{width:2px}.chat::-webkit-scrollbar-track{background:transparent}.chat::-webkit-scrollbar-thumb{background:var(--accent);border-radius:2px;opacity:.5}

/* MESSAGES */
.msg{display:flex;flex-direction:column;gap:5px;animation:msgIn .5s cubic-bezier(.16,1,.3,1)}
.msg-head{display:flex;align-items:center;gap:7px;font-weight:600;font-size:11px;color:var(--text)}
.msg-time{font-weight:400;font-size:9px;color:var(--text-dim);margin-left:auto;opacity:.6}
.av{width:22px;height:22px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}
.av-user{background:var(--surface2);color:var(--text);border:1px solid var(--border2)}
.av-ai{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;box-shadow:0 0 10px rgba(124,106,255,.3)}
.msg-body{padding-left:29px;line-height:1.75;color:var(--text);white-space:pre-wrap;word-break:break-word;font-size:13px}
.msg-user .msg-body{background:var(--surface);border:1px solid var(--border2);border-radius:14px;padding:10px 14px;margin-left:29px;color:var(--text-bright);backdrop-filter:blur(8px)}
.msg-body pre{background:var(--code-bg);border:1px solid var(--border2);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:8px 0;font-size:12px;line-height:1.6;color:#c9d1d9;position:relative}
.msg-body pre::-webkit-scrollbar{height:6px}
.msg-body pre::-webkit-scrollbar-track{background:rgba(0,0,0,.2);border-radius:4px}
.msg-body pre::-webkit-scrollbar-thumb{background:rgba(124,106,255,.3);border-radius:4px}
.msg-body pre::-webkit-scrollbar-thumb:hover{background:rgba(124,106,255,.6)}
.msg-body code{font-family:'SF Mono','JetBrains Mono','Fira Code','Menlo',monospace;font-size:11.5px}
.msg-body :not(pre)>code{background:rgba(124,106,255,.1);color:var(--accent);padding:2px 7px;border-radius:5px;border:1px solid rgba(124,106,255,.15)}
.msg-body a{color:var(--accent);text-decoration:none}
.msg-body a:hover{text-decoration:underline}
.code-wrap{position:relative}
.code-lang{position:absolute;top:0;left:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;padding:2px 10px;border-radius:0 0 6px 6px;font-size:9px;font-family:'SF Mono',monospace;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.copy-btn{position:absolute;top:8px;right:8px;background:var(--surface2);border:1px solid var(--border2);color:var(--text-dim);padding:4px 12px;border-radius:6px;font-size:10px;cursor:pointer;opacity:0;transition:all .3s;font-family:inherit;z-index:1;backdrop-filter:blur(8px)}
.code-wrap:hover .copy-btn{opacity:1}.copy-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 0 12px var(--accent-glow)}
.copy-btn.copied{background:var(--green);color:#fff;border-color:var(--green);opacity:1}

/* BADGES */
.file-badge{background:rgba(255,171,64,.05);border:1px solid rgba(255,171,64,.2);border-radius:10px 10px 0 0;border-bottom:none;padding:8px 14px;font-size:11px;font-weight:700;color:var(--yellow);display:flex;align-items:center;gap:6px;backdrop-filter:blur(8px)}
.edit-badge{background:rgba(0,229,255,.05);border:1px solid rgba(0,229,255,.2);border-radius:10px 10px 0 0;border-bottom:none;padding:8px 14px;font-size:11px;font-weight:700;color:var(--cyan);display:flex;align-items:center;gap:6px;backdrop-filter:blur(8px)}
.cmd-badge{background:rgba(124,106,255,.05);border:1px solid rgba(124,106,255,.25);border-radius:10px;padding:10px 14px;margin:8px 0;font-size:12px;color:var(--accent);font-family:'SF Mono','Menlo',monospace;display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px)}
.msg-error .msg-body{color:var(--red);text-shadow:0 0 20px rgba(255,82,82,.2)}

/* WELCOME */
.welcome{text-align:center;padding:0 20px 20px;position:relative}
.welcome-logo{width:56px;height:56px;border-radius:16px;margin:0 auto 16px;background:#050505;border:1px solid rgba(0,255,65,.3);display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--accent);box-shadow:inset 0 0 15px rgba(0,255,65,.1), 0 0 30px rgba(0,255,65,.2);animation:welcomeFloat 4s ease-in-out infinite;position:relative;text-shadow:0 0 15px var(--accent)}
.welcome-logo::before{content:'';position:absolute;inset:-2px;border-radius:18px;background:var(--accent);opacity:.15;filter:blur(8px);animation:pulseGlow 3s linear infinite}
@keyframes pulseGlow{0%,100%{opacity:.15;filter:blur(8px)}50%{opacity:.3;filter:blur(12px)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes welcomeFloat{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-6px) scale(1.03)}}
.welcome-title{font-size:22px;font-weight:900;letter-spacing:-1px;color:var(--text-bright);margin-bottom:8px}
@keyframes gradText{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.welcome-sub{color:var(--text-dim);font-size:12px;line-height:1.7;margin-bottom:18px;letter-spacing:-.2px}
.quick-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:14px;padding:0 10px}
.qa-btn{background:var(--surface);border:1px solid var(--border2);color:var(--text);padding:7px 12px;border-radius:18px;font-size:11px;cursor:pointer;font-family:inherit;transition:all .25s;backdrop-filter:blur(8px)}
.qa-btn:hover{color:var(--text-bright);border-color:var(--accent);background:var(--surface2);transform:translateY(-1px);box-shadow:0 4px 12px var(--accent-glow)}

/* LOADING */
.loading-wrap{padding-left:29px;padding-top:6px;display:flex;align-items:center;gap:10px}
.loading-dots{display:flex;gap:4px}
.loading-dots span{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:dotBounce 1.4s ease-in-out infinite}
.loading-dots span:nth-child(2){animation-delay:.2s;background:var(--accent2)}
.loading-dots span:nth-child(3){animation-delay:.4s;background:var(--accent3)}
@keyframes dotBounce{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1.2);opacity:1}}
.loading-text{font-size:11px;color:var(--text-dim);animation:pulse 2s ease-in-out infinite;letter-spacing:.3px}

/* INPUT */
.input-wrap{padding:8px 14px 14px;flex-shrink:0;position:relative;z-index:1}
.input-box{background:var(--input-bg);border:1px solid var(--border2);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;transition:all .3s;position:relative;backdrop-filter:blur(12px)}
.input-box:focus-within{border-color:var(--accent);box-shadow:0 0 24px rgba(0,255,65,.15);animation:focusPulse 3s infinite}
@keyframes focusPulse{0%,100%{box-shadow:0 0 20px rgba(0,255,65,.08)}50%{box-shadow:0 0 28px rgba(0,255,65,.2)}}
textarea{width:100%;background:transparent;border:none;color:var(--text-bright);font-family:inherit;font-size:13px;line-height:1.5;resize:none;outline:none;min-height:22px;max-height:150px}
textarea::placeholder{color:var(--text-dim)}
.input-footer{display:flex;align-items:center;justify-content:space-between}
.input-hint{font-size:10px;color:var(--text-dim);opacity:.5}
.input-btns{display:flex;gap:5px}
.send-btn{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;width:32px;height:32px;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;transition:all .2s;box-shadow:0 2px 12px rgba(124,106,255,.35);position:relative;overflow:hidden}
.send-btn::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,transparent,rgba(255,255,255,.15));opacity:0;transition:opacity .3s}
.send-btn:hover{transform:translateY(-2px) scale(1.05);box-shadow:0 6px 24px rgba(124,106,255,.45)}
.send-btn:hover::after{opacity:1}
.send-btn:active{transform:scale(.92)}.send-btn:disabled{opacity:.2;cursor:not-allowed;transform:none;box-shadow:none}
.stop-btn{background:var(--red);border:none;color:#fff;width:32px;height:32px;border-radius:10px;cursor:pointer;display:none;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 12px rgba(255,82,82,.3)}
.stop-btn.visible{display:flex}
@keyframes msgIn{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
.stream-active{position:relative}
.stream-active::after{content:'';display:inline-block;width:2px;height:14px;background:var(--accent);margin-left:2px;animation:blink .6s step-end infinite;vertical-align:text-bottom;border-radius:1px;box-shadow:0 0 6px var(--accent)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.stream-active .code-wrap:last-child {
  border: 1px solid var(--accent);
  animation: codePulse 2s infinite;
}
.stream-active .code-wrap:last-child pre {
  box-shadow: inset 0 0 20px rgba(124,106,255,0.05);
}
@keyframes codePulse {
  0%, 100% { box-shadow: 0 0 15px var(--accent-glow); }
  50% { box-shadow: 0 0 35px var(--accent2-glow); border-color: var(--accent2); }
}
.main-view{flex:1;display:flex;flex-direction:column;overflow:hidden;transition:all .5s cubic-bezier(.16,1,.3,1);min-height:0;max-height:100%}
body.init .main-view{justify-content:center;margin-top:-6vh}
body.init .chat{flex:0 0 auto;overflow:visible;padding-bottom:15px}
body.init .input-wrap{max-width:680px;width:100%;margin:0 auto;transform:none;transition:all .5s cubic-bezier(.16,1,.3,1)}

/* ATTACHMENT */
.attach-btn{background:transparent;border:1px solid var(--border2);color:var(--text-dim);width:32px;height:32px;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;transition:all .3s;flex-shrink:0}
.attach-btn:hover{color:var(--accent);border-color:var(--accent);box-shadow:0 0 12px var(--accent-glow);transform:translateY(-1px)}
.attach-preview{display:none;gap:6px;padding:0 0 6px;flex-wrap:wrap}
.attach-preview.visible{display:flex}
.attach-chip{display:flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:4px 10px;font-size:10px;color:var(--text);animation:msgIn .3s ease}
.attach-chip .chip-icon{font-size:12px}
.attach-chip .chip-name{max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attach-chip .chip-remove{cursor:pointer;color:var(--text-dim);font-size:12px;margin-left:2px;transition:color .2s}
.attach-chip .chip-remove:hover{color:var(--red)}
.attach-thumb{width:28px;height:28px;border-radius:5px;object-fit:cover;border:1px solid var(--border2)}

/* REGENERATE BUTTON */
.regen-btn{display:inline-flex;align-items:center;gap:4px;background:transparent;border:none;color:var(--text-dim);padding:4px 6px;border-radius:4px;font-size:11px;cursor:pointer;transition:color 0.2s;font-family:inherit;margin-top:6px;margin-left:29px;opacity:0.7}
.regen-btn:hover{color:var(--text);opacity:1}

/* SYNTAX HIGHLIGHTING */
.msg-body pre .kw{color:#c792ea}
.msg-body pre .str{color:#c3e88d}
.msg-body pre .num{color:#f78c6c}
.msg-body pre .cm{color:#546e7a;font-style:italic}
.msg-body pre .fn{color:#82aaff}
.msg-body pre .tag{color:#f07178}
.msg-body pre .attr{color:#ffcb6b}
.msg-body pre .op{color:#89ddff}
.msg-body pre .type{color:#ffcb6b}
</style></head><body class="init">
<div class="header"><div class="header-left"><div class="logo">\u2726</div><span class="brand">Connect AI</span></div><div class="header-right"><select id="modelSel"></select><button class="btn-icon" id="internetBtn" title="인터넷 검색 켜기 (현재: OFF)" style="opacity: 0.4; filter: grayscale(1);">🌐</button><button class="btn-icon" id="brainBtn" title="내 지식 관리">\ud83e\udde0</button><button class="btn-icon" id="settingsBtn" title="설정">\u2699\ufe0f</button><button class="btn-icon" id="newChatBtn" title="새 대화 시작">+</button></div></div>
<div class="thinking-bar" id="thinkingBar"></div>
<div class="main-view" id="mainView">
<div class="chat" id="chat">
<div id="welcomeRoot"></div></div>
<div class="input-wrap"><div class="input-box">
<div class="attach-preview" id="attachPreview"></div>
<textarea id="input" rows="1" placeholder="\ubb34\uc5c7\uc744 \ub9cc\ub4e4\uc5b4 \ub4dc\ub9b4\uae4c\uc694?"></textarea>
<div class="input-footer"><span class="input-hint">Enter \uc804\uc1a1 \u00b7 Shift+Enter \uc904\ubc14\uafc8</span>
<div class="input-btns"><button class="attach-btn" id="attachBtn" title="\ud30c\uc77c \ucca8\ubd80 (AI\uc5d0\uac8c \ubcf4\uc5ec\uc8fc\uae30)">+</button><button class="attach-btn" id="injectLocalBtn" title="\ucca8\ubd80 \ud30c\uc77c\uc744 \ub0b4 \uc9c0\uc2dd\uc5d0 \uc601\uad6c \uc800\uc7a5">⚡</button><button class="stop-btn" id="stopBtn" title="\uc0dd\uc131 \uc911\ub2e8">\u25a0</button><button class="send-btn" id="sendBtn" title="\uc804\uc1a1 (Enter)">\u2191</button></div></div></div>
<input type="file" id="fileInput" multiple accept="image/*,audio/*,.txt,.md,.csv,.json,.js,.ts,.html,.css,.py,.java,.rs,.go,.yaml,.yml,.xml,.toml" hidden></div>
</div>
<script>
window.onerror = function(msg, url, line, col, error) {
  document.body.innerHTML += '<div style="position:absolute;z-index:9999;background:red;color:white;padding:10px;top:0;left:0;right:0">ERROR: ' + msg + ' at line ' + line + '</div>';
};
window.addEventListener('unhandledrejection', function(event) {
  document.body.innerHTML += '<div style="position:absolute;z-index:9999;background:red;color:white;padding:10px;bottom:0;left:0;right:0">PROMISE REJECTION: ' + event.reason + '</div>';
});
try {
const vscode=acquireVsCodeApi(),chat=document.getElementById('chat'),input=document.getElementById('input'),
sendBtn=document.getElementById('sendBtn'),stopBtn=document.getElementById('stopBtn'),
modelSel=document.getElementById('modelSel'),newChatBtn=document.getElementById('newChatBtn'),settingsBtn=document.getElementById('settingsBtn'),brainBtn=document.getElementById('brainBtn'),
internetBtn=document.getElementById('internetBtn'),attachBtn=document.getElementById('attachBtn'),injectLocalBtn=document.getElementById('injectLocalBtn'),fileInput=document.getElementById('fileInput'),attachPreview=document.getElementById('attachPreview'),
thinkingBar=document.getElementById('thinkingBar');
let loader=null,sending=false,pendingFiles=[],internetEnabled=false;
function welcomeHtml(){
  return '<div class="welcome"><div class="welcome-logo">✦</div>'
    + '<div class="welcome-title">안녕하세요! 무엇을 도와드릴까요?</div>'
    + '<div class="welcome-sub">100% 로컬에서 동작하는 AI 코딩 도우미.<br>인터넷 없이, API 비용 없이, 내 PC에서 바로 실행됩니다.</div>'
    + '<div class="quick-actions">'
    + '<button class="qa-btn" data-prompt="현재 열린 파일에 대해 설명해줘">📖 코드 설명해줘</button>'
    + '<button class="qa-btn" data-prompt="이 프로젝트에서 버그나 개선점을 찾아줘">🐛 버그 찾아줘</button>'
    + '<button class="qa-btn" data-prompt="이 코드에 대한 단위 테스트를 작성해줘">🧪 테스트 만들어줘</button>'
    + '<button class="qa-btn" data-prompt="이 코드를 더 깔끔하게 리팩터링해줘">✨ 리팩터링해줘</button>'
    + '</div></div>';
}

internetBtn.addEventListener('click', ()=>{
  internetEnabled=!internetEnabled;
  internetBtn.style.opacity=internetEnabled?'1':'0.4';
  internetBtn.style.filter=internetEnabled?'none':'grayscale(1)';
  internetBtn.title='Internet & Time Sync: ' + (internetEnabled?'ON':'OFF') + ' (Click to toggle)';
  const msg = document.createElement('div');
  msg.className='msg';
  msg.innerHTML='<div class="msg-body" style="color:#00bdff;font-size:12px;opacity:0.8;">🌐 인터넷 및 시간 동기화 모드가 ' + (internetEnabled?'ON':'OFF') + ' 되었습니다.</div>';
  chat.appendChild(msg);
  chat.scrollTop=chat.scrollHeight;
});

/* Syntax Highlighting (lightweight) */
function highlight(code,lang){
  let h=esc(code);
  h=h.replace(new RegExp("(\\\\/\\\\/[^\\\\n]*)", "g"),'<span class=\"cm\">$1</span>');
  h=h.replace(new RegExp("(#[^\\\\n]*)", "g"),'<span class=\"cm\">$1</span>');
  h=h.replace(new RegExp("(\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\/)", "g"),'<span class=\"cm\">$1</span>');
  h=h.replace(/(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;)/g,'<span class=\"str\">$1</span>');
  h=h.replace(new RegExp("\\\\b(function|const|let|var|return|if|else|for|while|class|import|export|from|default|async|await|try|catch|throw|new|this|def|self|print|lambda|yield|with|as|raise|except|finally)\\\\b", "g"),'<span class=\"kw\">$1</span>');
  h=h.replace(new RegExp("\\\\b(\\\\d+\\\\.?\\\\d*)\\\\b", "g"),'<span class=\"num\">$1</span>');
  h=h.replace(new RegExp("\\\\b(True|False|None|true|false|null|undefined|NaN)\\\\b", "g"),'<span class=\"num\">$1</span>');
  h=h.replace(new RegExp("\\\\b(String|Number|Boolean|Array|Object|Map|Set|Promise|void|int|float|str|list|dict|tuple)\\\\b", "g"),'<span class=\"type\">$1</span>');
  h=h.replace(/([=!+*/%|&^~?:-]+)/g,'<span class=\"op\">$1</span>');
  return h;
}

/* Clipboard Paste (Ctrl+V images) */
input.addEventListener('paste',(e)=>{
  const items=e.clipboardData&&e.clipboardData.items;
  if(!items)return;
  for(const item of items){
    if(item.type.startsWith('image/')){
      e.preventDefault();
      const file=item.getAsFile();
      if(!file)return;
      const reader=new FileReader();
      reader.onload=()=>{
        const base64=reader.result.split(',')[1];
        pendingFiles.push({name:'clipboard-image.png',type:file.type,data:base64});
        renderPreview();
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});
vscode.postMessage({type:'getModels'});
setTimeout(()=>vscode.postMessage({type:'ready'}),300);
// Initial welcome render
const _wr=document.getElementById('welcomeRoot'); if(_wr) _wr.outerHTML=welcomeHtml();
input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,150)+'px'});
function getTime(){return new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}
function esc(s){const d=document.createElement('div');d.innerText=s;return d.innerHTML}
function fmt(t){
  if(t.lastIndexOf('<create_file') > t.lastIndexOf('</create_file>')) t += '</create_file>';
  if(t.lastIndexOf('<edit_file') > t.lastIndexOf('</edit_file>')) t += '</edit_file>';
  if(t.lastIndexOf('<run_command') > t.lastIndexOf('</run_command>')) t += '</run_command>';
  if((t.match(/\x60\x60\x60/g)||[]).length % 2 !== 0) t += '\\\\n\x60\x60\x60';

  const blocks = [];
  function pushB(h){ blocks.push(h); return '__B' + (blocks.length-1) + '__'; }
  t=t.replace(/<create_file\\s+path="([^"]+)">([\\s\\S]*?)<\\/create_file>/g,(_,p,c)=>pushB('<div class="file-badge">\ud83d\udcc1 '+esc(p)+' \u2014 \uc790\ub3d9 \uc0dd\uc131\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'));
  t=t.replace(/<edit_file\\s+path="([^"]+)">([\\s\\S]*?)<\\/edit_file>/g,(_,p,c)=>pushB('<div class="edit-badge">\u270f\ufe0f '+esc(p)+' \u2014 \ud3b8\uc9d1\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'));
  t=t.replace(/<run_command>([\\s\\S]*?)<\\/run_command>/g,(_,c)=>pushB('<div class="cmd-badge">\u25b6 '+esc(c)+'</div>'));
  t=t.replace(/\x60\x60\x60(\\w*)\\n([\\s\\S]*?)\x60\x60\x60/g,(_,lang,c)=>{const l=lang||'code';return pushB('<div class="code-wrap"><span class="code-lang">'+esc(l)+'</span><pre><code>'+highlight(c,l)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');});
  t=t.replace(/\x60([^\x60]+)\x60/g,(_,c)=>pushB('<code>'+esc(c)+'</code>'));
  t=esc(t);
  t=t.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  t=t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
  t=t.replace(/__B(\\d+)__/g, (_,i)=>blocks[i]);
  return t;
}
function copyCode(btn){const code=btn.parentElement.querySelector('code');if(!code)return;navigator.clipboard.writeText(code.innerText).then(()=>{btn.textContent='\u2713 Copied';btn.classList.add('copied');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},1500)})}
function addMsg(text,role){
  const isUser=role==='user',isErr=role==='error';
  const el=document.createElement('div');el.className='msg'+(isUser?' msg-user':'')+(isErr?' msg-error':'');
  const head=document.createElement('div');head.className='msg-head';
  head.innerHTML=(isUser?'<div class="av av-user">\ud83d\udc64</div><span>You</span>':'<div class="av av-ai">\u2726</div><span>Connect AI</span>')+'<span class="msg-time">'+getTime()+'</span>';
  const body=document.createElement('div');body.className='msg-body';
  if(isUser){body.innerText=text}else{body.innerHTML=fmt(text)}
  el.appendChild(head);el.appendChild(body);chat.appendChild(el);chat.scrollTop=chat.scrollHeight;
}
const LOADING_PHASES=[
  '\ud83d\udcc2 \ud504\ub85c\uc81d\ud2b8 \ud30c\uc77c \uc0b4\ud3b4\ubcf4\ub294 \uc911...',
  '\ud83e\udde0 \uad00\ub828 \uc815\ubcf4 \ubaa8\uc73c\ub294 \uc911...',
  '\ud83e\udd14 \ub2f5\ubcc0 \uad6c\uc131\ud558\ub294 \uc911...',
  '\u270d\ufe0f \ub2f5\ubcc0 \uc791\uc131\ud558\ub294 \uc911...'
];
let _loaderTimer=null;
function showLoader(){
  loader=document.createElement('div');loader.className='msg';
  loader.innerHTML='<div class="msg-head"><div class="av av-ai">\u2726</div><span>Connect AI</span><span class="msg-time">'+getTime()+'</span></div><div class="loading-wrap"><div class="loading-dots"><span></span><span></span><span></span></div><span class="loading-text" id="loadingTextEl">'+LOADING_PHASES[0]+'</span></div>';
  chat.appendChild(loader);chat.scrollTop=chat.scrollHeight;thinkingBar.classList.add('active');
  // \ub2e8\uacc4\ubcc4 \uba54\uc2dc\uc9c0 \uc21c\ucc28 \uc804\ud658 (\uc0ac\uc6a9\uc790\uac00 \uc9c4\ud589 \uc0c1\ud669\uc744 \uc778\uc9c0\ud560 \uc218 \uc788\ub3c4\ub85d)
  let phase=0;
  if(_loaderTimer) clearInterval(_loaderTimer);
  _loaderTimer=setInterval(()=>{
    phase=(phase+1)%LOADING_PHASES.length;
    const el=document.getElementById('loadingTextEl');
    if(el) el.textContent=LOADING_PHASES[phase];
  },2500);
}
function hideLoader(){if(_loaderTimer){clearInterval(_loaderTimer);_loaderTimer=null;}if(loader&&loader.parentNode)loader.parentNode.removeChild(loader);loader=null;thinkingBar.classList.remove('active')}
function setSending(v){sending=v;sendBtn.disabled=v;stopBtn.classList.toggle('visible',v);input.disabled=v;if(!v){input.focus();thinkingBar.classList.remove('active')}}
function send(){
  const text=input.value.trim();
  if((!text&&pendingFiles.length===0)||sending)return;
  document.body.classList.remove('init');
  const w=document.querySelector('.welcome');if(w)w.remove();
  document.querySelectorAll('.quick-actions').forEach(e=>e.remove());
  const displayText=text+(pendingFiles.length>0?'\\\\n\\ud83d\\udcce '+pendingFiles.map(f=>f.name).join(', '):'');
  addMsg(displayText,'user');
  input.value='';input.style.height='auto';setSending(true);showLoader();
  if(pendingFiles.length>0){
    vscode.postMessage({type:'promptWithFile',value:text||'\uc774 \ud30c\uc77c\uc744 \ubd84\uc11d\ud574\uc8fc\uc138\uc694.',model:modelSel.value,files:pendingFiles,internet:internetEnabled});
    pendingFiles=[];attachPreview.innerHTML='';attachPreview.classList.remove('visible');
  } else {
    vscode.postMessage({type:'prompt',value:text,model:modelSel.value,internet:internetEnabled});
  }
}

/* Attachment Logic */
attachBtn.addEventListener('click',()=>fileInput.click());
injectLocalBtn.addEventListener('click',()=>{
  if(pendingFiles.length===0){
    alert('\ucca8\ubd80\ub41c \ud30c\uc77c\uc774 \uc5c6\uc2b5\ub2c8\ub2e4. + \ubc84\ud2bc\uc744 \ub20c\ub7ec \uc5f0\ub3d9\ud560 \ubb38\uc11c\ub97c \uba3c\uc800 \ucd94\uac00\ud574\uc8fc\uc138\uc694.');
    return;
  }
  vscode.postMessage({type:'injectLocalBrain', files:pendingFiles});
  pendingFiles=[];
  renderPreview();
});
fileInput.addEventListener('change',()=>{
  const files=Array.from(fileInput.files);
  files.forEach(file=>{
    const reader=new FileReader();
    reader.onload=()=>{
      const base64=reader.result.split(',')[1];
      pendingFiles.push({name:file.name,type:file.type,data:base64});
      renderPreview();
    };
    reader.readAsDataURL(file);
  });
  fileInput.value='';
});
function renderPreview(){
  attachPreview.innerHTML='';
  if(pendingFiles.length===0){attachPreview.classList.remove('visible');return;}
  attachPreview.classList.add('visible');
  pendingFiles.forEach((f,i)=>{
    const chip=document.createElement('div');chip.className='attach-chip';
    const isImg=f.type.startsWith('image/');
    if(isImg){
      const thumb=document.createElement('img');thumb.className='attach-thumb';thumb.src='data:'+f.type+';base64,'+f.data;chip.appendChild(thumb);
    } else {
      const icon=document.createElement('span');icon.className='chip-icon';icon.textContent=f.type.startsWith('audio/')?'\ud83c\udfa7':'\ud83d\udcc4';chip.appendChild(icon);
    }
    const nm=document.createElement('span');nm.className='chip-name';nm.textContent=f.name;chip.appendChild(nm);
    const rm=document.createElement('span');rm.className='chip-remove';rm.textContent='\u2715';
    rm.addEventListener('click',()=>{pendingFiles.splice(i,1);renderPreview();});
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
}
document.addEventListener('click',e=>{if(e.target.classList.contains('qa-btn')){const p=e.target.getAttribute('data-prompt');if(p){input.value=p;send()}}});
sendBtn.addEventListener('click',send);
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
newChatBtn.addEventListener('click',()=>vscode.postMessage({type:'newChat'}));
settingsBtn.addEventListener('click',()=>vscode.postMessage({type:'openSettings'}));
brainBtn.addEventListener('click',()=>vscode.postMessage({type:'syncBrain'}));
stopBtn.addEventListener('click',()=>{vscode.postMessage({type:'stopGeneration'});hideLoader();setSending(false);if(streamBody){streamBody.classList.remove('stream-active')}streamEl=null;streamBody=null;});
let streamEl=null,streamBody=null;
window.addEventListener('message',e=>{const msg=e.data;switch(msg.type){
  case 'response':hideLoader();setSending(false);addMsg(msg.value,'ai');break;
  case 'error':hideLoader();setSending(false);addMsg(msg.value,'error');break;
  case 'streamStart':{
    hideLoader();
    streamEl=document.createElement('div');streamEl.className='msg';
    const h=document.createElement('div');h.className='msg-head';
    h.innerHTML='<div class="av av-ai">\u2726</div><span>Connect AI</span><span class="msg-time">'+getTime()+'</span>';
    streamBody=document.createElement('div');streamBody.className='msg-body stream-active';
    streamEl.appendChild(h);streamEl.appendChild(streamBody);chat.appendChild(streamEl);chat.scrollTop=chat.scrollHeight;
    break;}
  case 'streamChunk':{
    if(streamBody){streamBody.innerHTML=fmt(streamBody._raw=(streamBody._raw||'')+msg.value);chat.scrollTop=chat.scrollHeight;}
    break;}
  case 'streamEnd':{
    if(streamBody)streamBody.classList.remove('stream-active');
    /* Add regenerate button */
    if(streamEl){
      const rb=document.createElement('button');rb.className='regen-btn';rb.innerHTML='<span style="font-size:13px;line-height:1">↻</span> 재생성';
      rb.addEventListener('click',()=>{rb.remove();vscode.postMessage({type:'regenerate'});showLoader();setSending(true);});
      streamEl.appendChild(rb);
    }
    setSending(false);streamEl=null;streamBody=null;
    break;}
  case 'modelsList':modelSel.innerHTML='';msg.value.forEach(m=>{const o=document.createElement('option');o.value=m;o.textContent=m;modelSel.appendChild(o)});break;
  case 'clearChat':
    document.body.classList.add('init');
    chat.innerHTML=welcomeHtml();
    break;
  case 'restoreMessages':
    chat.innerHTML='';
    if(msg.value&&msg.value.length>0){
      document.body.classList.remove('init');
      msg.value.forEach(m=>addMsg(m.text,m.role));
    } else {
      document.body.classList.add('init');
      chat.innerHTML=welcomeHtml();
    }
    break;
  case 'focusInput':input.focus();break;
  case 'injectPrompt':input.value=msg.value;input.style.height='auto';input.style.height=Math.min(input.scrollHeight,150)+'px';send();break;
} });
} catch(err) {
  document.body.innerHTML = '<div style="color:#ff4444;padding:20px;background:#111;height:100%;font-size:14px;overflow:auto;"><h2>\u26a0\ufe0f WEBVIEW JS CRASH</h2><pre>' + err.name + ': ' + err.message + '\\n' + err.stack + '</pre></div>';
}
</script></body></html>`;
    }
}
