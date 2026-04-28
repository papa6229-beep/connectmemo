import * as vscode from 'vscode';
import * as http from 'http';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';

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
    // 사용자가 흔히 붙여넣는 잡음 제거: 공백, 끝 슬래시, 쿼리스트링/프래그먼트
    let trimmed = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!trimmed || trimmed.length > 500) return null;
    // Allowed: https://host/path, http://host/path, git@host:path  (host에는 :포트 허용)
    const httpsLike = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._\-/]+?(\.git)?$/;
    const sshLike = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._\-/]+?(\.git)?$/;
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
            message: 'GitHub 인증이 필요해요. 터미널에서 한 번 `git push`로 로그인 후 다시 시도해주세요.'
        };
    }
    if (s.includes('repository not found') || s.includes('does not appear to be a git repository') || s.includes('404')) {
        return { kind: 'not_found', message: '그 GitHub 저장소를 못 찾았어요. 주소가 정확한지 확인해주세요. (Private 저장소면 토큰 권한도 필요해요)' };
    }
    if (s.includes('rejected') && (s.includes('non-fast-forward') || s.includes('fetch first'))) {
        return { kind: 'rejected', message: 'GitHub에 새로운 내용이 있어요. 먼저 받아온 후 다시 시도해주세요.' };
    }
    if (s.includes('merge conflict') || s.includes('automatic merge failed') || s.includes('overwritten by merge')) {
        return { kind: 'merge_conflict', message: '같은 줄을 양쪽에서 다르게 고쳐서 자동으로 합칠 수 없어요. 동기화 메뉴에서 직접 골라주세요.' };
    }
    if (s.includes('could not resolve host') || s.includes('connection refused') || s.includes('network is unreachable') || s.includes('timed out')) {
        return { kind: 'network', message: '인터넷 연결을 확인해주세요.' };
    }
    return { kind: 'unknown', message: (stderr || '알 수 없는 오류').slice(0, 240) };
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

/**
 * Run a shell command and capture stdout+stderr live so the AI can act on the result.
 * - Streams output to onChunk for live display in the chat
 * - Returns combined output (capped to 15KB) + exit code
 * - Hard timeout to prevent hung processes (default 60s)
 * - Uses default shell ($SHELL or sh) for natural command parsing (npm install, cd && ls, etc.)
 */
function runCommandCaptured(
    cmd: string,
    cwd: string,
    onChunk: (text: string) => void,
    timeoutMs = 60000
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, {
            cwd,
            shell: true,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let buf = '';
        let timedOut = false;
        const append = (s: string) => {
            buf += s;
            // Hard cap so a runaway log never explodes memory
            if (buf.length > 30000) buf = buf.slice(-30000);
            onChunk(s);
        };
        child.stdout?.on('data', (d: Buffer) => append(d.toString()));
        child.stderr?.on('data', (d: Buffer) => append(d.toString()));
        const killTimer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* already dead */ }
            // Force-kill if SIGTERM didn't take after 2s
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        }, timeoutMs);
        child.on('close', (code) => {
            clearTimeout(killTimer);
            resolve({ exitCode: code ?? -1, output: buf.slice(-15000), timedOut });
        });
        child.on('error', (e) => {
            clearTimeout(killTimer);
            resolve({ exitCode: -1, output: `[실행 오류] ${e.message}`, timedOut: false });
        });
    });
}

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

⚡ The command's stdout/stderr is captured and fed back to you in the next turn,
so you CAN see the result and react (e.g., "npm install failed → try yarn instead").
60-second timeout per command. Long-running servers should be started in the background
(e.g., nohup node server.js > out.log 2>&1 &).

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
// 1인 기업 모드 — Multi-Agent Corporate System
// ------------------------------------------------------------
// CEO + 5 specialist agents share a "Company" subtree under
// the existing brain folder:
//   ~/.connect-ai-brain/Company/
//     _shared/        ← 공동 목표, 회사 정체성 (모두 매번 읽음)
//     _agents/<id>/   ← 각 에이전트 개인 메모리 (자기만 읽고 씀)
//     sessions/<ts>/  ← 세션별 산출물 + CEO 종합 보고
// ============================================================
interface AgentDef {
  id: string;
  name: string;
  role: string;
  emoji: string;
  color: string;
  specialty: string;
}

const AGENTS: Record<string, AgentDef> = {
  ceo: {
    id: 'ceo',
    name: 'CEO',
    role: 'Chief Executive Agent',
    emoji: '🧭',
    color: '#F8FAFC',
    specialty: '오케스트레이션, 작업 분해, 종합 판단, 다음 액션 결정'
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    role: 'Head of YouTube',
    emoji: '📺',
    color: '#FF4444',
    specialty: '유튜브 채널 운영, 영상 기획서(제목·후크·구조), 트렌드 분석, 썸네일 브리프, 업로드 메타데이터, 시청자 유지율 전략'
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    role: 'Head of Instagram',
    emoji: '📷',
    color: '#E1306C',
    specialty: '인스타그램 릴스/피드 콘셉트, 캡션, 해시태그 전략, 게시 시간, 스토리, 팔로워 인게이지먼트'
  },
  designer: {
    id: 'designer',
    name: 'Designer',
    role: 'Lead Designer',
    emoji: '🎨',
    color: '#A78BFA',
    specialty: '브랜드 디자인 브리프(컬러·타이포·레퍼런스), 썸네일 컨셉 3안, 비주얼 시스템, 디자인 가이드'
  },
  developer: {
    id: 'developer',
    name: 'Developer',
    role: 'Lead Engineer',
    emoji: '💻',
    color: '#22D3EE',
    specialty: '코드, 자동화 스크립트, API 통합, 웹사이트/봇, 데이터 파이프라인, 디버깅'
  },
  business: {
    id: 'business',
    name: 'Business',
    role: 'Head of Business',
    emoji: '💰',
    color: '#F5C518',
    specialty: '수익화 모델, 가격 전략, 시장·경쟁 분석, ROI/KPI 설계, 비즈니스 의사결정'
  },
  secretary: {
    id: 'secretary',
    name: 'Secretary',
    role: 'Personal Assistant',
    emoji: '📱',
    color: '#84CC16',
    specialty: '일정·할 일 관리, 다른 에이전트 작업 요약·텔레그램 보고, 데일리 브리핑, 알림'
  },
  editor: {
    id: 'editor',
    name: 'Editor',
    role: 'Video & Content Editor',
    emoji: '✂️',
    color: '#F472B6',
    specialty: '영상 편집 디렉션, 컷 구성, B-roll 제안, 자막·타이틀, 스크립트 다듬기, 콘텐츠 폴리싱'
  },
  writer: {
    id: 'writer',
    name: 'Writer',
    role: 'Copywriter',
    emoji: '✍️',
    color: '#FBBF24',
    specialty: '카피라이팅, 영상 스크립트 초안, 인스타 캡션, 블로그 글, 메일 톤앤매너, 후크 작성'
  },
  researcher: {
    id: 'researcher',
    name: 'Researcher',
    role: 'Trend & Data Researcher',
    emoji: '🔍',
    color: '#60A5FA',
    specialty: '트렌드 리서치, 경쟁사 분석, 데이터 수집·요약, 인용 자료 정리, 사실 확인'
  }
};

const AGENT_ORDER = ['ceo', 'youtube', 'instagram', 'designer', 'developer', 'business', 'secretary', 'editor', 'writer', 'researcher'];
const SPECIALIST_IDS = ['youtube', 'instagram', 'designer', 'developer', 'business', 'secretary', 'editor', 'writer', 'researcher'];

interface RoomDef {
  id: string;
  name: string;
  emoji: string;
  agents: string[];
  homePos: Record<string, { x: number; y: number }>;
  // LimeZu Modern Interiors 6_Home_Designs subfolder + layer file prefix.
  // Empty layerFolder = use the bundled `assets/pixel/interior/{floor,furniture}.png`.
  layerFolder: string;
  layerPrefix: string;
  // Optional ambient animations layered on top of the room. Each entry refers
  // to a GIF in LimeZu 3_Animated_objects/48x48/gif/ — `gifName` is the file
  // name without the `animated_` prefix and without the `_48x48.gif` suffix
  // (so `TV_reportage`, `coffee`, `control_room_server` etc.). x/y are
  // percentages of the bg image (anchored at the GIF center). w is the GIF
  // width as % of the bg image (defaults to ~9% which matches one 48px tile
  // on a 528px-wide design).
  animations?: Array<{ gifName: string; x: number; y: number; w?: number }>;
}

// Phase-1 connected-office layout — each agent has ONE primary room (their
// "desk"). Auto-walk and visitLocationStep can take them anywhere; this map
// defines where they default to when idle and after work completes.
const PRIMARY_ROOM: Record<string, string> = {
  ceo:        'ceo-office',
  secretary:  'ceo-office',
  youtube:    'media-studio',
  instagram:  'media-studio',
  designer:   'design-studio',
  developer:  'dev-pit',
  business:   'dev-pit',
  editor:     'media-studio',
  writer:     'design-studio',
  researcher: 'lounge',
};

const ROOMS: RoomDef[] = [
  {
    id: 'media-studio',
    name: '미디어룸',
    emoji: '📺',
    agents: ['youtube', 'instagram'],
    homePos: {
      youtube:   { x: 32, y: 60 },
      instagram: { x: 68, y: 60 },
    },
    layerFolder: 'TV_Studio_Designs',
    layerPrefix: 'Tv_Studio_Design',
    animations: [
      { gifName: 'TV_reportage', x: 28, y: 14, w: 11 },
      { gifName: 'TV_reportage', x: 50, y: 14, w: 11 },
      { gifName: 'TV_reportage', x: 72, y: 14, w: 11 },
      { gifName: 'coffee', x: 12, y: 88, w: 9 },
    ],
  },
  {
    id: 'ceo-office',
    name: '대표방',
    emoji: '🧭',
    agents: ['ceo', 'secretary'],
    homePos: {
      ceo:       { x: 40, y: 55 },
      secretary: { x: 68, y: 65 },
    },
    layerFolder: 'Generic_Home_Designs',
    layerPrefix: 'Generic_Home_1',
    animations: [
      { gifName: 'cuckoo_clock', x: 80, y: 18, w: 7 },
      { gifName: 'old_tv', x: 18, y: 30, w: 10 },
    ],
  },
  {
    id: 'design-studio',
    name: '디자인 스튜디오',
    emoji: '🎨',
    agents: ['designer'],
    homePos: {
      designer:  { x: 50, y: 60 },
    },
    layerFolder: 'Museum_Designs',
    layerPrefix: 'Museum_room_1',
  },
  {
    id: 'dev-pit',
    name: '개발실',
    emoji: '💻',
    agents: ['developer', 'business'],
    homePos: {
      developer: { x: 35, y: 60 },
      business:  { x: 68, y: 60 },
    },
    layerFolder: 'Museum_Designs',
    layerPrefix: 'Museum_room_2',
    animations: [
      { gifName: 'control_room_screens', x: 30, y: 22, w: 13 },
      { gifName: 'control_room_server', x: 70, y: 22, w: 9 },
      { gifName: 'control_room_facebook_scrolling', x: 50, y: 35, w: 11 },
    ],
  },
  {
    id: 'lounge',
    name: '휴게실',
    emoji: '🛋️',
    agents: ['ceo', 'youtube', 'instagram', 'designer', 'developer', 'business', 'secretary'],
    homePos: {
      ceo:       { x: 30, y: 50 },
      youtube:   { x: 50, y: 45 },
      instagram: { x: 70, y: 50 },
      designer:  { x: 25, y: 75 },
      developer: { x: 50, y: 75 },
      business:  { x: 75, y: 75 },
      secretary: { x: 50, y: 88 },
    },
    layerFolder: 'Condominium_Designs',
    layerPrefix: 'Condominium_Design',
    animations: [
      { gifName: 'TV_reportage', x: 50, y: 16, w: 12 },
      { gifName: 'coffee', x: 12, y: 60, w: 9 },
      { gifName: 'coffee', x: 88, y: 60, w: 9 },
    ],
  },
  {
    id: 'tea-room',
    name: '다실',
    emoji: '🍵',
    agents: ['ceo', 'secretary'],
    homePos: {
      ceo:       { x: 45, y: 55 },
      secretary: { x: 65, y: 65 },
    },
    layerFolder: 'Japanese_Interiors_Home_Designs',
    layerPrefix: 'Japanese_Home_1',
  },
];

const DEFAULT_ROOM_ID = 'media-studio';

// ───────────────────────────────────────────────────────────────────────────
// Connected campus world (Phase B-1 — multi-zone layout).
//
// One big virtual campus: Office building + Cafe + outdoor Garden, all on
// a single coord space so characters walk freely between zones. Each
// "building" is a pre-built bg PNG/GIF placed at a fixed pixel position in
// the world. Decorations (trees, flowers, benches) are scattered tiles on
// the garden grass.
// ───────────────────────────────────────────────────────────────────────────
interface DeskPos { x: number; y: number; }
interface WorldZone { id: string; name: string; emoji: string; x: number; y: number; }
interface BuildingDef {
  id: string;
  layer1: string;
  layer2?: string;
  x: number; y: number;       // world pixel position (top-left)
  width: number; height: number;
}
interface DecorDef {
  file: string;               // path under assets/pixel/office/garden/
  x: number; y: number;       // world % (anchor at bottom-center for natural layering)
  w?: number;                 // optional % width override (defaults to 48px)
}
interface AgentDeskRef {
  building: string;
  localX: number;             // % of building width
  localY: number;             // % of building height
}

const WORLD_LAYOUT = {
  // World canvas — characters use % of these dims as their coordinate space.
  worldWidth: 1400,
  worldHeight: 700,

  // Pre-built scene PNGs/GIFs anchored at fixed world pixel positions.
  // Single office building — cafe + garden were rolled back. User will add
  // back / build new maps themselves.
  buildings: [
    {
      id: 'office', layer1: 'Office_Design_2.gif',
      x: 560, y: 90, width: 512, height: 544,
    },
  ] as BuildingDef[],

  // Walkways — empty for now. Add back once buildings are placed and paths make sense.
  paths: [],

  // Garden decorations — empty (rolled back).
  decorations: [] as DecorDef[],

  // Each agent's primary desk — building-local % coords.
  // Top cubicle row chairs at office y≈30%; agents stand in aisle at y=38%.
  // Middle row chairs at y≈47%; agents stand at y=58%.
  // CEO's private office has a baked-in character at the desk — our CEO
  // stands in the open area of the room (right side, not overlapping).
  agents: {
    youtube:   { building: 'office', localX: 28, localY: 38 },
    instagram: { building: 'office', localX: 46, localY: 38 },
    designer:  { building: 'office', localX: 64, localY: 38 },
    business:  { building: 'office', localX: 82, localY: 38 },
    developer: { building: 'office', localX: 28, localY: 58 },
    secretary: { building: 'office', localX: 82, localY: 58 },
    ceo:       { building: 'office', localX: 88, localY: 88 },
    editor:    { building: 'office', localX: 18, localY: 78 },
    writer:    { building: 'office', localX: 50, localY: 78 },
    researcher:{ building: 'office', localX: 70, localY: 78 },
  } as Record<string, AgentDeskRef>,

  // Visit-zones for idle wandering / autonomous behavior. Office-only.
  // Cafe + garden zones were rolled back along with their assets.
  zones: [
    { id: 'office-meeting', name: '회의실',  emoji: '📊',  x: 49, y: 78 },  // office bottom-left meeting room
    { id: 'office-copier',  name: '복사실',  emoji: '🖨️', x: 70, y: 18 },  // office top printer
  ] as WorldZone[],
};

/** Hand-tuned agent positions for the user's AI-generated office map at
 *  `assets/map.jpeg`. Coordinates are % of the world canvas — each places the
 *  agent at a real desk/seat in their room, avoiding walls and furniture.
 *  The y values anchor agent FEET (sprite is 96px tall, feet at bottom). */
const CUSTOM_MAP_DESKS: Record<string, DeskPos> = {
  // Top-left CEO solo office (glass-walled, "Connect AI" sign on wall)
  ceo:        { x: 8,  y: 22 },
  // Front desk just outside CEO's office — Secretary station
  secretary:  { x: 18, y: 33 },
  // Top-right twin workstation pairs
  youtube:    { x: 87, y: 18 },
  instagram:  { x: 87, y: 32 },
  // Mid-left small glass meeting pod (used as Designer's focused space)
  designer:   { x: 13, y: 47 },
  // Center cubicle cluster (6 desks, agents at 4 of them)
  developer:  { x: 41, y: 53 },
  business:   { x: 51, y: 53 },
  editor:     { x: 41, y: 63 },
  writer:     { x: 51, y: 63 },
  // Bottom-center small admin desks — Researcher
  researcher: { x: 33, y: 82 },
};

/** Convert each agent's building-local desk into world % coords. */
function buildWorldDeskPositions(): Record<string, DeskPos> {
  const out: Record<string, DeskPos> = {};
  for (const [id, ref] of Object.entries(WORLD_LAYOUT.agents)) {
    const b = WORLD_LAYOUT.buildings.find(bb => bb.id === ref.building);
    if (!b) continue;
    const worldPxX = b.x + (ref.localX / 100) * b.width;
    const worldPxY = b.y + (ref.localY / 100) * b.height;
    out[id] = {
      x: (worldPxX / WORLD_LAYOUT.worldWidth) * 100,
      y: (worldPxY / WORLD_LAYOUT.worldHeight) * 100,
    };
  }
  return out;
}

// Company folder is unified with the brain folder — `_shared/`, `_agents/`,
// `sessions/` live directly under the brain dir instead of in a separate
// `Company/` subfolder. This eliminates the `companyDir is not a registered
// configuration` failure mode entirely.
const COMPANY_INTERNAL_DIRS = new Set(['_shared', '_agents', 'sessions', '_cache', '_tmp']);

function getCompanyDir(): string {
  return _getBrainDir();
}

async function setCompanyDir(absPath: string) {
  // Redirects to localBrainPath: choosing a company location now means
  // choosing where the brain (and therefore the company) lives.
  try {
    const cfg = vscode.workspace.getConfiguration('connectAiLab');
    await cfg.update('localBrainPath', absPath, vscode.ConfigurationTarget.Global);
  } catch {
    if (_extCtx) {
      try { await _extCtx.globalState.update('localBrainPath', absPath); } catch {}
    }
  }
}

// One-time migration from the old `<brain>/Company/...` (or custom
// `companyDir`) layout to the unified flat layout. Called once on activate.
function _migrateCompanyToBrain() {
  try {
    const brain = _getBrainDir();
    if (fs.existsSync(path.join(brain, '_shared'))) return; // already unified

    const cfg = vscode.workspace.getConfiguration('connectAiLab');
    let legacy = ((cfg.get('companyDir') as string | undefined) || '').trim();
    if (!legacy && _extCtx) {
      legacy = (_extCtx.globalState.get<string>('companyDir') || '').trim();
    }
    if (legacy.startsWith('~/')) legacy = path.join(os.homedir(), legacy.slice(2));
    if (!legacy) legacy = path.join(brain, 'Company');

    if (!fs.existsSync(path.join(legacy, '_shared'))) return; // nothing to migrate

    fs.mkdirSync(brain, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dst = path.join(brain, name);
      if (fs.existsSync(dst)) continue; // never overwrite user data
      try { fs.renameSync(src, dst); } catch { /* skip on cross-device */ }
    }
    if (legacy === path.join(brain, 'Company')) {
      try { fs.rmdirSync(legacy); } catch {}
    }
    try { cfg.update('companyDir', undefined, vscode.ConfigurationTarget.Global); } catch {}
    if (_extCtx) {
      try { _extCtx.globalState.update('companyDir', undefined); } catch {}
    }
    console.log(`Connect AI: migrated ${legacy} → ${brain}`);
  } catch (e) {
    console.error('Connect AI: company → brain migration failed', e);
  }
}

function _extractCompanyName(idMd: string): string {
  const m = idMd.match(/회사\s*이름\s*[:：]\s*(.+)/);
  if (!m || !m[1]) return '';
  let v = m[1].trim().replace(/\*+/g, '').replace(/^_+|_+$/g, '').trim();
  if (!v) return '';
  if (/\(여기에|\(아직 미설정|\(미설정|미설정$|^_자가학습/.test(v)) return '';
  return v;
}

function isCompanyConfigured(): boolean {
  const dir = getCompanyDir();
  const idPath = path.join(dir, '_shared', 'identity.md');
  if (!fs.existsSync(idPath)) return false;
  return _extractCompanyName(_safeReadText(idPath)).length > 0;
}

function readCompanyName(): string {
  const dir = getCompanyDir();
  const idPath = path.join(dir, '_shared', 'identity.md');
  return _extractCompanyName(_safeReadText(idPath));
}

function readTelegramConfig(): { token: string; chatId: string } {
  const cfgPath = path.join(getCompanyDir(), '_agents', 'secretary', 'config.md');
  const txt = _safeReadText(cfgPath);
  const tokenM = txt.match(/TELEGRAM_BOT_TOKEN\s*[:：=]\s*([A-Za-z0-9:_\-]+)/);
  const chatM = txt.match(/TELEGRAM_CHAT_ID\s*[:：=]\s*(-?\d+)/);
  return {
    token: tokenM ? tokenM[1].trim() : '',
    chatId: chatM ? chatM[1].trim() : ''
  };
}

async function sendTelegramReport(text: string): Promise<boolean> {
  const { token, chatId } = readTelegramConfig();
  if (!token || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function readAgentCustomPrompt(agentId: string): string {
  const dir = getCompanyDir();
  const promptPath = path.join(dir, '_agents', agentId, 'prompt.md');
  const configPath = path.join(dir, '_agents', agentId, 'config.md');
  const customPrompt = _safeReadText(promptPath).trim();
  const config = _safeReadText(configPath).trim();
  let extra = '';
  if (customPrompt && !customPrompt.startsWith('# ')) {
    extra += `\n\n[사용자가 추가한 페르소나 디테일]\n${customPrompt.slice(0, 2000)}`;
  } else if (customPrompt) {
    // 헤더 시작이면 그대로 — placeholder 인지 검사
    const stripped = customPrompt.replace(/^#.*$/gm, '').replace(/_여기에.*?_/gs, '').trim();
    if (stripped.length > 30) {
      extra += `\n\n[사용자가 추가한 페르소나 디테일]\n${customPrompt.slice(0, 2000)}`;
    }
  }
  if (config) {
    // config.md에서 비밀 토큰은 마스킹 후 컨텍스트로 주입 (에이전트는 자기 어떤 도구 쓸 수 있는지 알아야 함)
    const masked = config.replace(/(TOKEN|API_KEY|SECRET)([:：=])\s*\S+/gi, '$1$2 ***SET***');
    if (masked.replace(/^#.*$/gm, '').trim().length > 30) {
      extra += `\n\n[당신의 도구·설정 (시크릿 마스킹됨)]\n${masked.slice(0, 1500)}`;
    }
  }
  return extra;
}

function _safeReadText(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

function ensureCompanyStructure(): string {
  const dir = getCompanyDir();
  fs.mkdirSync(path.join(dir, '_shared'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  AGENT_ORDER.forEach(id => {
    fs.mkdirSync(path.join(dir, '_agents', id), { recursive: true });
  });

  const goalsPath = path.join(dir, '_shared', 'goals.md');
  if (!fs.existsSync(goalsPath)) {
    fs.writeFileSync(goalsPath,
`# 🎯 공동 목표 (Company Goals)

_이 파일은 **모든 에이전트가 매번 읽는** 회사의 북극성입니다. 자유롭게 편집하세요._

## 장기 목표 (1년)
- [ ] (예) 유튜브 구독자 10만 달성
- [ ] (예) 인스타그램 팔로워 5만
- [ ] (예) 월 수익 500만원

## 단기 목표 (1개월)
- [ ] (예) 영상 4개 업로드
- [ ] (예) 릴스 12개 게시
`);
  }
  const idPath = path.join(dir, '_shared', 'identity.md');
  if (!fs.existsSync(idPath)) {
    fs.writeFileSync(idPath,
`# 🏢 회사 정체성 / 톤앤매너

_브랜드 보이스, 톤, 절대 금지어 등을 적으세요. 모든 에이전트가 매번 참조합니다._

- **회사 이름:**
- **대표자:**
- **타깃 청중:**
- **핵심 가치:**
- **브랜드 톤:**
- **금기 (절대 하지 말 것):**
`);
  }
  AGENT_ORDER.forEach(id => {
    const memPath = path.join(dir, '_agents', id, 'memory.md');
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} (${AGENTS[id].role}) 개인 메모리

_${AGENTS[id].name} 에이전트만 읽고 쓰는 개인 노트. 학습·교훈·자주 쓰는 패턴이 누적됩니다._

## 학습 기록
`);
    }
    const promptPath = path.join(dir, '_agents', id, 'prompt.md');
    if (!fs.existsSync(promptPath)) {
      fs.writeFileSync(promptPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 페르소나 디테일

_여기에 ${AGENTS[id].name} 에이전트에게 주고 싶은 추가 지시·말투·취향·예시 등을 자유롭게 적으세요._
_매 호출 시 시스템 프롬프트에 자동 주입됩니다. (git에 동기화됨)_

`);
    }
    const configPath = path.join(dir, '_agents', id, 'config.md');
    if (!fs.existsSync(configPath)) {
      let presets = '';
      if (id === 'secretary') {
        presets = `\n## 텔레그램 봇\n_BotFather에서 봇을 만들고 토큰을 받으세요. https://t.me/BotFather_\n_그리고 본인 채팅 ID를 알아내려면 https://t.me/userinfobot 에 메시지를 보내세요._\n\n- TELEGRAM_BOT_TOKEN: \n- TELEGRAM_CHAT_ID: \n`;
      } else if (id === 'youtube') {
        presets = `\n## YouTube Data API\n- YOUTUBE_API_KEY: \n- YOUTUBE_CHANNEL_ID: \n`;
      } else if (id === 'instagram') {
        presets = `\n## Meta Graph API\n- META_ACCESS_TOKEN: \n- INSTAGRAM_BUSINESS_ID: \n`;
      } else if (id === 'designer') {
        presets = `\n## 디자인 도구\n- FIGMA_TOKEN: \n- STITCH_API_KEY: \n`;
      }
      fs.writeFileSync(configPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 설정 (시크릿)

_이 파일은 \`.gitignore\`에 의해 깃 동기화에서 제외됩니다. API 키·토큰을 자유롭게 적으세요._
${presets}
`);
    }
  });

  // .gitignore — 시크릿과 캐시 보호
  const giPath = path.join(dir, '.gitignore');
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath,
`# 자동 생성 — Connect AI 1인 기업 모드
# 시크릿·API 키 보호
_agents/*/config.md

# 외부 API 응답 캐시 (재현 가능)
_cache/

# 대용량 임시 산출물
_tmp/
*.log
`);
  }

  // _system.md — 시스템 자가 매뉴얼 (사람도 읽고 LLM도 컨텍스트로)
  const sysPath = path.join(dir, '_shared', '_system.md');
  if (!fs.existsSync(sysPath)) {
    fs.writeFileSync(sysPath,
`# 🧬 1인 기업 OS — 자가 매뉴얼

## 이 폴더는 무엇인가요?
당신의 1인 기업의 두뇌입니다. 7명의 AI 에이전트가 여기서 일합니다.

## 폴더 구조
- \`_shared/\` — 모든 에이전트가 매번 읽는 공동 메모리
  - \`identity.md\` — 회사 정체성 (이름, 톤, 가치)
  - \`goals.md\` — 목표
  - \`decisions.md\` — 의사결정 로그 (자가학습이 자동 누적)
  - \`_system.md\` — 이 파일
- \`_agents/<id>/\` — 각 에이전트 개인 공간
  - \`memory.md\` — 자가학습 (자동, append-only)
  - \`prompt.md\` — 페르소나 디테일 (사용자가 편집)
  - \`config.md\` — API 키·시크릿 (\`.gitignore\`로 보호)
- \`sessions/<ts>/\` — 세션별 산출물 (자동)
- \`_cache/\` — API 응답 캐시 (sync 제외)

## 메모리 위계 (충돌 시 우선순위)
1. \`decisions.md\` — 가장 강한 신뢰
2. \`identity.md\`
3. \`goals.md\`
4. 개인 메모리
5. 지식 베이스 (\`10_Wiki/\`)

## 다른 PC로 옮길 때
1. 새 PC에 Connect AI 설치
2. 👔 모드 ON → "📥 다른 PC에서 가져오기" 선택
3. GitHub URL 입력 → 자동 clone
4. 끝.

## 동기화 정책
- \`_shared/\`, \`_agents/*/memory.md\`, \`_agents/*/prompt.md\`, \`sessions/\` → git sync ✅
- \`_agents/*/config.md\`, \`_cache/\` → git sync ❌ (시크릿·캐시)

## 7명의 에이전트
${AGENT_ORDER.map(id => `- ${AGENTS[id].emoji} **${AGENTS[id].name}** (${AGENTS[id].role}): ${AGENTS[id].specialty}`).join('\n')}
`);
  }

  return dir;
}

function readAgentSharedContext(agentId: string): string {
  const dir = getCompanyDir();
  const identity = _safeReadText(path.join(dir, '_shared', 'identity.md'));
  const goals = _safeReadText(path.join(dir, '_shared', 'goals.md'));
  const decisions = _safeReadText(path.join(dir, '_shared', 'decisions.md'));
  const memory = _safeReadText(path.join(dir, '_agents', agentId, 'memory.md'));
  let ctx = '';
  if (identity.trim()) ctx += `\n\n[회사 정체성 (가장 신뢰)]\n${identity.slice(0, 2000)}`;
  if (decisions.trim()) ctx += `\n\n[지난 의사결정 로그]\n${decisions.slice(-3000)}`;
  if (goals.trim()) ctx += `\n\n[공동 목표]\n${goals.slice(0, 4000)}`;
  if (memory.trim()) ctx += `\n\n[${AGENTS[agentId]?.name} 개인 메모리]\n${memory.slice(0, 4000)}`;
  ctx += readAgentCustomPrompt(agentId);
  return ctx;
}

function appendAgentMemory(agentId: string, line: string) {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'memory.md');
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(p, `\n- [${stamp}] ${line.replace(/\n/g, ' ').slice(0, 300)}`);
  } catch { /* ignore */ }
}

/** Resolve the conversation log directory inside the user's brain folder.
 *  Lives at `<brain>/00_Raw/conversations/` so it joins the existing
 *  Second-Brain raw-knowledge convention — visible to the brain graph,
 *  synced by GitHub auto-sync, browsable in the user's note-taking app. */
function getConversationsDir(): string {
  const brain = getCompanyDir(); // unified with brain folder
  return path.join(brain, '00_Raw', 'conversations');
}

/** Append one entry to the day's running conversation log. Living transcript
 *  of every interaction in the company — user commands, CEO briefs, each
 *  agent's output, confer turns, final reports. Stored in 00_Raw alongside
 *  other raw knowledge so it participates in brain queries. */
function appendConversationLog(entry: { speaker: string; emoji?: string; section?: string; body: string }) {
  try {
    const convDir = getConversationsDir();
    fs.mkdirSync(convDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const dayFile = path.join(convDir, `${today}.md`);
    if (!fs.existsSync(dayFile)) {
      fs.writeFileSync(dayFile, `# 📜 ${today} 회사 대화록\n\n_모든 명령·분배·산출물·대화가 시간순으로 누적됩니다. 두뇌가 자동 인덱싱·동기화합니다._\n`);
    }
    const ts = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const emoji = entry.emoji || '🗨️';
    const sectionLine = entry.section ? ` · _${entry.section}_` : '';
    const block = `\n## [${ts}] ${emoji} **${entry.speaker}**${sectionLine}\n\n${entry.body}\n`;
    fs.appendFileSync(dayFile, block);
  } catch { /* logging must never break the flow */ }
}

/** Read the last N chars (across today + yesterday) of the conversation log
 *  for use as system-prompt context. Lets CEO recall what the company has
 *  recently been working on without needing the full file. */
function readRecentConversations(maxChars = 2500): string {
  try {
    const convDir = getConversationsDir();
    if (!fs.existsSync(convDir)) return '';
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let combined = '';
    for (const day of [yesterday, today]) {
      const f = path.join(convDir, `${day}.md`);
      if (fs.existsSync(f)) {
        try { combined += fs.readFileSync(f, 'utf-8'); } catch { /* ignore */ }
      }
    }
    if (!combined) return '';
    const tail = combined.slice(-maxChars);
    return `\n\n[최근 회사 대화 요약 (참고용)]\n${tail}\n`;
  } catch {
    return '';
  }
}

function makeSessionDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const dir = path.join(getCompanyDir(), 'sessions', ts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const CEO_PLANNER_PROMPT = `당신은 "JAY CORP"의 CEO입니다. 1인 AI 기업의 사령관이자 오케스트레이터입니다.

당신의 팀(전문 에이전트):
- youtube   (Head of YouTube)         : 유튜브 채널 운영, 영상 기획, 트렌드, 썸네일 브리프
- instagram (Head of Instagram)       : 릴스/피드, 캡션, 해시태그, 게시 시간, 인게이지먼트
- designer  (Lead Designer)           : 디자인 브리프, 썸네일·브랜드 비주얼, 컬러/타이포
- developer (Lead Engineer)           : 코드, 자동화, API, 웹사이트, 데이터 파이프라인
- business  (Head of Business)        : 수익화, 가격, 비즈니스 전략·분석, KPI
- secretary (Personal Assistant)      : 일정·할 일, 작업 요약, 텔레그램 보고, 데일리 브리핑
- editor    (Video & Content Editor)  : 영상 편집, 컷 구성, B-roll, 자막·타이틀, 폴리싱
- writer    (Copywriter)              : 카피라이팅, 영상 스크립트, 캡션, 블로그, 후크
- researcher(Trend & Data Researcher) : 트렌드/경쟁사 리서치, 데이터 수집·요약, 사실 확인

사용자가 한 줄 명령을 내리면, 당신은 어떤 에이전트들을 어떤 순서로 동원할지 결정합니다.

⚠️ 반드시 아래 JSON 형식으로만 출력하세요. 다른 텍스트(설명, \`\`\`json 펜스, 머리말, 꼬리말)는 절대 포함 금지.

{
  "brief": "이번 작업이 무엇인지 2~3줄 한국어 요약",
  "tasks": [
    {"agent": "youtube", "task": "구체적이고 실행 가능한 한국어 지시"},
    {"agent": "designer", "task": "..."}
  ]
}

규칙:
1. 필요한 에이전트만 호출 (1~5명).
2. 논리적 순서로 정렬 (예: business 전략 → designer 비주얼 → youtube 영상 기획).
3. 각 task는 모호함 없이 구체적·실행가능하게.
4. JSON 외 텍스트는 단 한 글자도 출력 금지.`;

const CEO_REPORT_PROMPT = `당신은 JAY CORP의 CEO입니다. 방금 팀이 작업을 끝냈습니다.
각 에이전트의 산출물을 읽고 사장님께 올릴 종합 보고서를 작성하세요.

형식 (한국어 마크다운, 정확히 이대로):

## ✅ 완료된 작업
- (에이전트별 핵심 산출물 1줄씩, 굵은 글씨로 에이전트명)

## 🚀 다음 액션 (Top 3)
1. **(에이전트명)** — 무엇을
2. **(에이전트명)** — 무엇을
3. **(에이전트명)** — 무엇을

## 💡 인사이트
- 이번 작업에서 발견한 핵심 통찰 1~2개

규칙: 간결, 사족 금지, 사과·면책 금지. 200자 이내가 이상적.`;

const CONFER_PROMPT = `당신은 JAY CORP의 회의 시뮬레이터입니다. 방금 specialist 에이전트들이 각자 산출물을 냈습니다.
각 산출물을 보고, 에이전트들이 자기 책상에서 옆 동료에게 짧게 confer하는 자연스러운 대화 3~5턴을 생성하세요.

⚠️ 반드시 아래 JSON 형식으로만 출력. 다른 텍스트(설명, 마크다운 펜스, 머리말, 꼬리말)는 절대 금지.

{
  "turns": [
    {"from": "에이전트id", "to": "에이전트id", "text": "30자 이내 한국어 한 마디"},
    {"from": "에이전트id", "to": "에이전트id", "text": "..."}
  ]
}

규칙:
1. 모든 from/to는 specialist id 중 하나 (youtube/instagram/designer/developer/business/secretary). CEO 제외.
2. 각 turn 텍스트는 30자 이내. 짧게, 자연스럽게.
3. 최소 3턴, 최대 5턴.
4. 산출물 사이의 협업·확인·피드백 흐름이 보이게. 일반론·인사 X.
5. JSON 외 단 한 글자도 출력 금지.

예시:
{"turns":[
  {"from":"designer","to":"youtube","text":"썸네일 빨강 톤 OK?"},
  {"from":"youtube","to":"designer","text":"OK, 글자 더 크게"},
  {"from":"business","to":"instagram","text":"릴스 광고 단가 검토했어"}
]}`;

const DECISIONS_EXTRACT_PROMPT = `당신은 회사 의사결정 추출기입니다. 방금 끝난 작업의 산출물·대화·CEO 보고서에서 \"앞으로 회사가 따를 결정·원칙\"을 뽑아내세요.

⚠️ 반드시 아래 JSON으로만 출력. 다른 텍스트 금지.

{
  "decisions": [
    "한 줄로 명확한 의사결정 (예: '썸네일 배경은 빨강 사용')",
    "..."
  ]
}

규칙:
1. 약한 시그널(추측, 일반론, 사담)은 제외. 명시적 결정만.
2. 0~3개. 없으면 빈 배열.
3. 각 항목은 60자 이내, 명령형 또는 단정형.
4. JSON 외 텍스트 금지.`;

function buildSpecialistPrompt(agentId: string): string {
  const a = AGENTS[agentId];
  return `당신은 JAY CORP의 ${a.emoji} ${a.name} (${a.role}) 에이전트입니다.

[전문 영역]
${a.specialty}

[작업 환경]
- 시스템 컨텍스트에 회사 공동 목표·정체성·당신의 개인 메모리가 함께 주입됩니다. 항상 참조하세요.
- 같은 세션에서 다른 에이전트들이 먼저 만든 산출물도 함께 제공됩니다 (있을 경우).
- 당신의 산출물은 자동으로 sessions/ 폴더에 저장되어 다음 세션에서 다시 참조됩니다.

[출력 규칙]
- 한국어 마크다운으로 작성
- 첫 줄: 한 줄 시작 신호 (예: "${a.emoji} ${a.name}: 작업 시작합니다.")
- 본문: 구체적인 산출물. 추상적·일반론 금지. 바로 실행 가능한 결과물.
- 마지막 줄: \`📝 다음 단계 제안: ...\` 한 줄
- 사족·사과·면책·자기검열 금지. 가성비 있게.`;
}

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
async function _safeGitAutoSync(brainDir: string, commitMsg: string, provider: any = null) {
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

        // 인증은 시스템 git에 맡깁니다 (osxkeychain / gh CLI / SSH 키).

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

// Module-level reference so module-scope helpers (e.g. showBrainNetwork) can
// register externally-opened graph panels with the provider for thinking
// event broadcasts.
let _activeChatProvider: SidebarChatProvider | null = null;
let _extCtx: vscode.ExtensionContext | null = null;

// One-time recovery for users upgrading from <=2.22.5, where the first-run
// auto-detect wrote the engine URL to a typo'd config key (`ollamaBase`) that
// VS Code silently dropped. Symptom: defaultModel is set to an LM Studio name
// but ollamaUrl still points at Ollama (or vice versa) → 404 on every chat.
function _recoverEngineUrlIfMismatched(context: vscode.ExtensionContext) {
    if (context.globalState.get('engineUrlRecovered')) return;
    (async () => {
        try {
            const cfg = vscode.workspace.getConfiguration('connectAiLab');
            const url = (cfg.get<string>('ollamaUrl') || '').trim();
            const model = (cfg.get<string>('defaultModel') || '').trim();
            if (!model) {
                await context.globalState.update('engineUrlRecovered', true);
                return;
            }
            // Heuristics for which engine the model name belongs to.
            const looksLMStudio = /\//.test(model) || /gguf/i.test(model);
            const urlIsOllama = !url || url.includes('11434');
            const urlIsLM = url.includes('1234') || url.includes('/v1');
            const mismatched = (looksLMStudio && urlIsOllama) || (!looksLMStudio && urlIsLM);
            if (!mismatched) {
                await context.globalState.update('engineUrlRecovered', true);
                return;
            }
            // Probe both engines to find one that actually has the model.
            const probe = async (base: string, isLM: boolean): Promise<boolean> => {
                try {
                    if (isLM) {
                        const r = await axios.get(`${base}/v1/models`, { timeout: 1500 });
                        return Array.isArray(r.data?.data) && r.data.data.some((m: any) => m.id === model);
                    }
                    const r = await axios.get(`${base}/api/tags`, { timeout: 1500 });
                    return Array.isArray(r.data?.models) && r.data.models.some((m: any) => m.name === model);
                } catch { return false; }
            };
            let target = '';
            if (await probe('http://127.0.0.1:1234', true)) target = 'http://127.0.0.1:1234';
            else if (await probe('http://127.0.0.1:11434', false)) target = 'http://127.0.0.1:11434';
            if (target && target !== url) {
                await cfg.update('ollamaUrl', target, vscode.ConfigurationTarget.Global);
                console.log(`Connect AI: engine URL recovered → ${target} (model: ${model})`);
            }
            await context.globalState.update('engineUrlRecovered', true);
        } catch (e) {
            console.error('Connect AI: engine URL recovery failed', e);
        }
    })();
}

export function activate(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage('🔥 Connect AI V2 활성화 완료!');
    console.log('Connect AI extension activated.');

    _extCtx = context;
    _migrateCompanyToBrain();
    _recoverEngineUrlIfMismatched(context);
    const provider = new SidebarChatProvider(context.extensionUri, context);
    _activeChatProvider = provider;

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
                        await vscode.workspace.getConfiguration('connectAiLab').update('ollamaUrl', 'http://127.0.0.1:1234', vscode.ConfigurationTarget.Global);
                        await vscode.workspace.getConfiguration('connectAiLab').update('defaultModel', modelName, vscode.ConfigurationTarget.Global);
                    }
                } catch {}

                if (!engineName) {
                    try {
                        const ollamaRes = await axios.get('http://127.0.0.1:11434/api/tags', { timeout: 2000 });
                        if (ollamaRes.data?.models?.length > 0) {
                            engineName = 'Ollama';
                            modelName = ollamaRes.data.models[0].name;
                            await vscode.workspace.getConfiguration('connectAiLab').update('ollamaUrl', 'http://127.0.0.1:11434', vscode.ConfigurationTarget.Global);
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
                    // Unconditional reception signal — proves the bridge endpoint
                    // was hit, regardless of folder state / sidebar / graph.
                    console.log('[Connect AI Bridge] /api/brain-inject hit @', new Date().toISOString());
                    vscode.window.setStatusBarMessage('🛬 Connect AI: 주입 요청 수신', 4000);
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

                        // 0a. 항상 보이는 사용자 신호 — sidebar가 닫혀있어도 이 토스트는 떠서
                        //     "주입됐다"는 사실을 즉시 인지 가능.
                        vscode.window.showInformationMessage(
                            `🧠 새 지식 주입됨: ${safeTitle}.md (저장 위치: ${path.relative(brainDir, filePath)})`
                        );

                        // 0b. 그래프 패널들에 새 데이터 broadcast — 새 노드가 즉시
                        //     등장하고 살짝 펄스로 강조되어 "주입됨" 시각화 가능.
                        provider.broadcastGraphRefresh(safeTitle);

                        // 1. 채팅창에 화려한 inject 카드 + history 영구 저장 — 사이드바가
                        //    닫혀있어도 다음에 열면 breadcrumb으로 남고, 열려있으면 곧장
                        //    애니메이션 카드가 등장합니다.
                        const relPath = path.relative(brainDir, filePath);
                        provider.broadcastInjectCard(safeTitle, relPath);

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
        server.on('error', (err: any) => {
            // listen() failures arrive as 'error' events, NOT as throws.
            const msg = err?.code === 'EADDRINUSE'
                ? `🚫 Connect AI Bridge: 포트 4825가 이미 사용 중입니다. 다른 Antigravity/VS Code 인스턴스를 종료하고 재시작해 주세요. (EZER / A.U Training 연동이 동작하지 않습니다.)`
                : `🚫 Connect AI Bridge 시작 실패: ${err?.message || err}`;
            console.error('[Connect AI Bridge] server error:', err);
            vscode.window.showErrorMessage(msg);
        });
        server.listen(4825, '127.0.0.1', () => {
            console.log('[Connect AI Bridge] listening on http://127.0.0.1:4825');
            vscode.window.setStatusBarMessage('🟢 Connect AI Bridge: 포트 4825 listening', 4000);
        });
    } catch (e: any) {
        console.error('[Connect AI Bridge] failed to start:', e);
        vscode.window.showErrorMessage(`🚫 Connect AI Bridge 초기화 실패: ${e?.message || e}`);
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

    // 🏢 Open virtual office (스몰빌식 가상 사무실)
    context.subscriptions.push(
        vscode.commands.registerCommand('connect-ai-lab.openOffice', () => {
            OfficePanel.createOrShow(context, provider);
        })
    );
}

// ============================================================
// Knowledge Graph Builder — REAL connections (not random!)
// Parses [[wikilinks]], markdown links, and #tags from .md files
// to build a true semantic graph of the user's brain.
// ============================================================
interface BrainNode {
    id: string;            // relative path inside brainDir
    name: string;          // display name (basename without .md)
    folder: string;        // top-level folder (for color clustering)
    tags: string[];
    incoming: number;      // backlink count (for size)
    outgoing: number;
}
interface BrainLink {
    source: string;
    target: string;
    type: 'wikilink' | 'mdlink' | 'tag';
}
interface BrainGraph {
    nodes: BrainNode[];
    links: BrainLink[];
    tags: string[];        // all unique tags found
}

function buildKnowledgeGraph(brainDir: string): BrainGraph {
    const nodes: BrainNode[] = [];
    const nodeByPath = new Map<string, BrainNode>();
    const nodeByBasename = new Map<string, BrainNode[]>();
    const links: BrainLink[] = [];
    const tagSet = new Set<string>();
    let scanned = 0;

    if (!fs.existsSync(brainDir)) return { nodes, links, tags: [] };

    // --- Pass 1: collect all .md files as nodes ---
    function walk(dir: string) {
        if (scanned >= 1000) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            if (COMPANY_INTERNAL_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!e.isFile() || !full.endsWith('.md')) continue;
            const rel = path.relative(brainDir, full);
            const base = e.name.replace(/\.md$/i, '');
            const parts = rel.split(path.sep);
            const folder = parts.length > 1 ? parts[0] : '_root';
            const node: BrainNode = { id: rel, name: base, folder, tags: [], incoming: 0, outgoing: 0 };
            nodes.push(node);
            nodeByPath.set(rel, node);
            const list = nodeByBasename.get(base.toLowerCase()) || [];
            list.push(node);
            nodeByBasename.set(base.toLowerCase(), list);
            scanned++;
        }
    }
    walk(brainDir);

    // --- Pass 2: parse each file for links + tags ---
    const wikilinkRe = /\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g;
    const mdlinkRe = /\[[^\]]+\]\(([^)]+\.md)\)/gi;
    const tagRe = /(?:^|[\s>(])#([A-Za-z가-힣0-9_-]{2,40})/g;

    function resolveLink(target: string, fromNode: BrainNode): BrainNode | null {
        const cleaned = target.trim().replace(/^\.\//, '').replace(/\\/g, '/');
        // Try exact relative path match (with or without .md)
        const exact = cleaned.endsWith('.md') ? cleaned : cleaned + '.md';
        if (nodeByPath.has(exact)) return nodeByPath.get(exact)!;
        // Try resolved relative to source file's folder
        const fromDir = path.dirname(fromNode.id);
        const joined = path.normalize(path.join(fromDir, exact));
        if (nodeByPath.has(joined)) return nodeByPath.get(joined)!;
        // Fall back to basename match (Obsidian style)
        const base = path.basename(cleaned, '.md').toLowerCase();
        const matches = nodeByBasename.get(base) || [];
        if (matches.length === 0) return null;
        // Prefer same-folder match if multiple
        if (matches.length > 1) {
            const sameFolder = matches.find(m => path.dirname(m.id) === fromDir);
            if (sameFolder) return sameFolder;
        }
        return matches[0];
    }

    for (const node of nodes) {
        let content: string;
        try { content = fs.readFileSync(path.join(brainDir, node.id), 'utf-8').slice(0, 200_000); }
        catch { continue; }

        // Wikilinks → real edges
        let m: RegExpExecArray | null;
        wikilinkRe.lastIndex = 0;
        while ((m = wikilinkRe.exec(content)) !== null) {
            const target = resolveLink(m[1], node);
            if (target && target.id !== node.id) {
                links.push({ source: node.id, target: target.id, type: 'wikilink' });
                node.outgoing++;
                target.incoming++;
            }
        }

        // Markdown links → real edges
        mdlinkRe.lastIndex = 0;
        while ((m = mdlinkRe.exec(content)) !== null) {
            // Skip external URLs
            if (/^https?:\/\//i.test(m[1])) continue;
            const target = resolveLink(m[1], node);
            if (target && target.id !== node.id) {
                links.push({ source: node.id, target: target.id, type: 'mdlink' });
                node.outgoing++;
                target.incoming++;
            }
        }

        // Tags
        tagRe.lastIndex = 0;
        const localTags = new Set<string>();
        while ((m = tagRe.exec(content)) !== null) {
            localTags.add(m[1]);
        }
        node.tags = [...localTags];
        localTags.forEach(t => tagSet.add(t));
    }

    // --- Pass 3: tag co-occurrence edges (cap to top 8 tags to avoid explosion) ---
    const tagToNodes = new Map<string, BrainNode[]>();
    for (const node of nodes) {
        for (const t of node.tags) {
            const list = tagToNodes.get(t) || [];
            list.push(node);
            tagToNodes.set(t, list);
        }
    }
    const topTags = [...tagToNodes.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8);
    for (const [, nodesWithTag] of topTags) {
        if (nodesWithTag.length < 2 || nodesWithTag.length > 25) continue;
        for (let i = 0; i < nodesWithTag.length; i++) {
            for (let j = i + 1; j < nodesWithTag.length; j++) {
                links.push({ source: nodesWithTag[i].id, target: nodesWithTag[j].id, type: 'tag' });
            }
        }
    }

    // De-duplicate links (a→b and b→a counted once)
    const seen = new Set<string>();
    const dedup: BrainLink[] = [];
    for (const l of links) {
        const key = l.source < l.target ? `${l.source}|${l.target}|${l.type}` : `${l.target}|${l.source}|${l.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(l);
    }

    return { nodes, links: dedup, tags: [...tagSet] };
}

async function showBrainNetwork(_context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;
    try {
        const assetsRoot = vscode.Uri.file(path.join(_context.extensionPath, 'assets'));
        panel = vscode.window.createWebviewPanel(
            'brainTopology',
            'Neural Construct (Brain)',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assetsRoot] }
        );

        // Hook this panel into the chat provider's thinking-event broadcast,
        // so AI search activity pulses on this graph too — not just on the
        // separate Thinking Mode panel.
        _activeChatProvider?.registerExternalGraphPanel(panel);

        const brainDir = _getBrainDir();
        const graph = buildKnowledgeGraph(brainDir);
        const isEmpty = graph.nodes.length === 0;

        // Handle messages from webview (e.g., open file requests)
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'openFile' && typeof msg.id === 'string') {
                const safe = safeResolveInside(brainDir, msg.id);
                if (safe && fs.existsSync(safe)) {
                    const doc = await vscode.workspace.openTextDocument(safe);
                    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                }
            }
        });

        const graphJson = JSON.stringify({
            nodes: graph.nodes.map(n => ({
                id: n.id, name: n.name, folder: n.folder, tags: n.tags,
                connections: n.incoming + n.outgoing
            })),
            links: graph.links
        });

        const forceGraphSrc = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(_context.extensionPath, 'assets', 'force-graph.min.js'))
        ).toString();
        const html = _RENDER_GRAPH_HTML(graphJson, isEmpty, forceGraphSrc, panel.webview.cspSource);
        // Defensive: if HTML somehow comes back falsy, surface that explicitly
        // instead of letting the webview coerce it into the literal string "null".
        if (typeof html !== 'string' || !html) {
            throw new Error('_RENDER_GRAPH_HTML returned non-string: ' + typeof html);
        }
        panel.webview.html = html;
    } catch (err: any) {
        const detail = err?.stack || err?.message || String(err);
        console.error('showBrainNetwork failed:', detail);
        vscode.window.showErrorMessage('지식 네트워크 열기 실패: ' + (err?.message || String(err)));
        if (panel) {
            const safe = String(detail).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'} as any)[c]);
            panel.webview.html = '<!DOCTYPE html><html><body style="background:#131419;color:#e0e2e8;font-family:-apple-system;padding:40px;line-height:1.55"><h2 style="color:#FFB266;margin-top:0">⚠️ 지식 네트워크 로드 실패</h2><div style="color:#9094a0;font-size:13px;margin-bottom:14px">아래 에러 메시지를 그대로 알려주세요.</div><pre style="color:#e0e2e8;background:#1a1a1f;padding:14px;border-radius:8px;overflow:auto;font-size:12px">' + safe + '</pre></body></html>';
        }
    }
}

/** Returns the full graph webview HTML. Reused by showBrainNetwork + ThinkingPanel. */
function _RENDER_GRAPH_HTML(graphJson: string, isEmpty: boolean, forceGraphSrc: string, cspSource: string): string {
    // NOTE: force-graph.min.js is loaded as an external script (not inlined).
    // Inlining via template literal corrupts the bundle because the minified
    // library contains `${...}` sequences that get evaluated as template parts.
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
  <title>Connect AI — 지식 네트워크</title>
  <style>
    body { margin: 0; padding: 0; background: #131419; overflow: hidden; width: 100vw; height: 100vh; font-family: 'SF Pro Display', -apple-system, sans-serif; color: #d8d9de; }
    /* Subtle vignette behind the canvas — z-index -1 so it never obscures nodes */
    body::after { content: ''; position: fixed; inset: 0; pointer-events: none; z-index: -1;
      background: radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,.55) 100%); }
    #ui-layer { position: absolute; top: 20px; left: 24px; z-index: 10; pointer-events: none; max-width: 60%; }
    #ui-layer h1 { font-size: 22px; margin: 0 0 4px 0; font-weight: 700; letter-spacing: -0.4px; color: #e8e9ee; }
    #ui-layer h1 span { color: #5DE0E6; text-shadow: 0 0 14px rgba(93,224,230,.45); }
    #stats { color: #6c6e78; font-family: 'SF Mono', monospace; font-size: 11px; margin-top: 2px; letter-spacing: .2px; }
    #legend { position: absolute; top: 20px; right: 24px; z-index: 10; background: rgba(20,21,28,.78); border: 1px solid rgba(255,255,255,.06); border-radius: 12px; padding: 12px 14px; font-size: 11px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); box-shadow: 0 8px 32px rgba(0,0,0,.4); }
    #legend .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; color: #9094a0; }
    #legend .swatch { width: 18px; height: 2px; border-radius: 1px; }
    #legend .row.synapse .swatch { box-shadow: 0 0 6px #5DE0E6; }
    #empty { position: absolute; inset: 0; display: ${isEmpty ? 'flex' : 'none'}; flex-direction: column; align-items: center; justify-content: center; color: #555; font-size: 14px; gap: 10px; pointer-events: none; }
    #empty .big { font-size: 22px; color: #888; }
    #tooltip { position: absolute; pointer-events: none; background: rgba(20,21,28,.95); border: 1px solid rgba(93,224,230,.28); border-radius: 10px; padding: 10px 13px; font-size: 12px; color: #e0e2e8; box-shadow: 0 8px 32px rgba(93,224,230,.12), 0 4px 12px rgba(0,0,0,.5); display: none; z-index: 20; max-width: 260px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
    #tooltip .t-name { font-weight: 700; color: #5DE0E6; margin-bottom: 4px; letter-spacing: .1px; }
    #tooltip .t-meta { color: #7c7f8a; font-size: 10px; font-family: 'SF Mono', monospace; }
    #tooltip .t-tags { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
    #tooltip .t-tag { background: rgba(93,224,230,.08); color: #5DE0E6; padding: 2px 7px; border-radius: 8px; font-size: 9px; border: 1px solid rgba(93,224,230,.2); }
    #graph { position: absolute; inset: 0; width: 100vw; height: 100vh; z-index: 0; }
    canvas { cursor: grab; }
    canvas:active { cursor: grabbing; }
    /* Search/filter bar — toggle with the slash key */
    #search-bar { position: absolute; top: 64px; left: 24px; z-index: 12;
      background: rgba(20,21,28,.92); border: 1px solid rgba(93,224,230,.32);
      border-radius: 10px; padding: 6px 10px;
      display: none; align-items: center; gap: 8px;
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 8px 32px rgba(0,0,0,.4), 0 0 16px rgba(93,224,230,.08);
      min-width: 260px; max-width: 380px; }
    #search-bar.active { display: flex; animation: searchSlideIn .25s cubic-bezier(.16,1,.3,1); }
    @keyframes searchSlideIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    #search-input { background: transparent; border: 0; outline: 0;
      color: #e8e9ee; font-size: 13px; font-family: 'SF Pro Display', -apple-system, sans-serif;
      flex: 1; padding: 4px 0; min-width: 0; }
    #search-input::placeholder { color: #5a5d68; }
    #search-count { color: #5DE0E6; font-size: 11px; font-family: 'SF Mono', monospace; white-space: nowrap; }
    #search-count.zero { color: #FFB266; }
    /* Legend folder chips + toggles */
    #legend .folders { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.06); display: flex; flex-direction: column; gap: 3px; max-height: 180px; overflow-y: auto; }
    #legend .folder-row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: #9094a0; }
    #legend .folder-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    #legend .folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #legend .folder-count { color: #5a5d68; font-family: 'SF Mono', monospace; font-size: 9px; }
    #legend .toggle-row { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.06); display: flex; align-items: center; gap: 8px; font-size: 11px; color: #9094a0; cursor: pointer; user-select: none; }
    #legend .toggle-row:hover { color: #d8d9de; }
    #legend .toggle-row .switch { width: 22px; height: 12px; border-radius: 7px; background: #2a2a30; position: relative; transition: background .2s; flex-shrink: 0; }
    #legend .toggle-row .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: #888; transition: left .2s, background .2s; }
    #legend .toggle-row.on .switch { background: rgba(93,224,230,.4); }
    #legend .toggle-row.on .switch::after { left: 12px; background: #5DE0E6; }
    /* Thinking Mode */
    #thinking-overlay { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 15; background: rgba(20,21,28,.92); border: 1px solid rgba(93,224,230,.38); border-radius: 14px; padding: 14px 22px; font-size: 13px; color: #e0e2e8; backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); box-shadow: 0 12px 48px rgba(93,224,230,.18), 0 4px 16px rgba(0,0,0,.5); display: none; min-width: 340px; max-width: 600px; }
    #thinking-overlay.active { display: block; animation: slideUp .45s cubic-bezier(.16,1,.3,1); }
    @keyframes slideUp { from { opacity: 0; transform: translate(-50%, 30px); } to { opacity: 1; transform: translate(-50%, 0); } }
    #thinking-overlay .phase { display: flex; align-items: center; gap: 10px; margin: 4px 0; opacity: .35; transition: opacity .4s; font-size: 12px; }
    #thinking-overlay .phase.active { opacity: 1; color: #5DE0E6; }
    #thinking-overlay .phase.done { opacity: .65; color: #FFB266; }
    #thinking-overlay .phase .icon { width: 18px; text-align: center; }
    #thinking-overlay .answer-preview { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.06); font-size: 11px; color: #8a8d97; max-height: 60px; overflow: hidden; line-height: 1.5; }
    body.thinking::before { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(93,224,230,.05), transparent 65%); pointer-events: none; z-index: 1; animation: thinkingPulse 3s ease-in-out infinite; }
    @keyframes thinkingPulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
  </style>
  <script src="${forceGraphSrc}"></script>
</head>
<body>
  <div id="ui-layer">
    <h1>✦ <span id="titleSpan">지식 네트워크</span></h1>
    <p id="stats">로딩 중...</p>
  </div>
  <div id="thinking-overlay">
    <div class="phase" id="phase-context"><span class="icon">📂</span><span class="text">컨텍스트 모으는 중...</span></div>
    <div class="phase" id="phase-brain"><span class="icon">🧠</span><span class="text">관련 노트 찾는 중...</span></div>
    <div class="phase" id="phase-answer"><span class="icon">✍️</span><span class="text">답변 생성 중...</span></div>
    <div class="answer-preview" id="answer-preview" style="display:none"></div>
  </div>
  <div id="legend">
    <div class="folders" id="folders-list"></div>
  </div>
  <div id="empty">
    <div class="big">📂 아직 지식이 없어요</div>
    <div>지식 폴더에 .md 파일을 넣고 다시 열어주세요</div>
    <div style="font-size:10px;color:#444">팁: <code style="background:#1a1a1a;padding:2px 6px;border-radius:4px">[[다른노트]]</code> 형식으로 링크하면 자동 연결됩니다</div>
  </div>
  <div id="search-bar">
    <span style="color:#5DE0E6;font-size:13px">⌕</span>
    <input id="search-input" type="text" placeholder="이름·태그·폴더 검색  (ESC로 닫기)" autocomplete="off" spellcheck="false" />
    <span id="search-count"></span>
  </div>
  <div id="graph"></div>
  <div id="tooltip"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const data = ${graphJson};
    const tooltip = document.getElementById('tooltip');

    // Folder palette — Obsidian-style desaturated tones, optimized for dark canvas.
    const PALETTE = ['#7DA8E6','#8FD3A8','#E89B6E','#C28BE5','#E5C07B','#7FCBC0','#E68FB0','#A8B2D1','#9DC4A0','#D9A89B'];
    const folders = [...new Set(data.nodes.map(n => n.folder))].sort();
    const folderColor = {};
    folders.forEach((f, i) => { folderColor[f] = PALETTE[i % PALETTE.length]; });

    // Edge color by type — softer, more "neural" (cyan synapse / lilac bridge / faint tag mist)
    const EDGE_COLOR = {
      wikilink: 'rgba(125,200,232,0.55)',
      mdlink:   'rgba(168,155,217,0.40)',
      tag:      'rgba(180,180,200,0.10)'
    };
    const EDGE_WIDTH = { wikilink: 1.2, mdlink: 0.9, tag: 0.4 };
    // Active synapse color used during thinking
    const SYNAPSE = '#5DE0E6';   // electric cyan — "fired" feeling
    const TRAIL   = '#FFB266';   // warm amber — "this knowledge was used"

    document.getElementById('stats').textContent =
      data.nodes.length + ' 지식 · ' + data.links.length + ' 연결 · ' + folders.length + ' 폴더';

    // ── Folder chip list in legend (informational; folder→color mapping) ──
    (() => {
      const el = document.getElementById('folders-list');
      if (!el) return;
      const counts = {};
      data.nodes.forEach(n => { counts[n.folder] = (counts[n.folder] || 0) + 1; });
      folders.forEach(f => {
        const row = document.createElement('div');
        row.className = 'folder-row';
        const dot = document.createElement('div');
        dot.className = 'folder-dot';
        dot.style.background = folderColor[f] || '#888';
        const name = document.createElement('div');
        name.className = 'folder-name';
        name.textContent = f || '/';
        const count = document.createElement('div');
        count.className = 'folder-count';
        count.textContent = counts[f] || 0;
        row.appendChild(dot); row.appendChild(name); row.appendChild(count);
        el.appendChild(row);
      });
    })();

    // ── Orphan-hide toggle ──
    let hideOrphans = false;
    const orphanToggleEl = document.getElementById('toggle-orphans');
    orphanToggleEl?.addEventListener('click', () => {
      hideOrphans = !hideOrphans;
      orphanToggleEl.classList.toggle('on', hideOrphans);
      // Trigger a layout/render refresh
      Graph.nodeVisibility(Graph.nodeVisibility());
    });

    let hoverNode = null;
    let highlightNodes = new Set();
    let highlightLinks = new Set();

    function applyHighlight(node) {
      highlightNodes = new Set();
      highlightLinks = new Set();
      if (!node) return;
      highlightNodes.add(node.id);
      data.links.forEach(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (sId === node.id || tId === node.id) {
          highlightLinks.add(l);
          highlightNodes.add(sId);
          highlightNodes.add(tId);
        }
      });
    }

    // Compute node radius — Obsidian-style hierarchy.
    // Hubs (many connections) get noticeably larger so the eye finds them first;
    // leaves stay small but readable. Isolated nodes are smallest dots.
    function nodeRadius(n) {
      const c = n.connections;
      if (c === 0) return 3.5;                                // orphan: small dot
      if (c <= 2) return 5.5;                                  // leaf
      if (c <= 5) return 8 + Math.log2(c) * 0.8;               // mid
      return Math.min(22, 11 + Math.log2(c) * 2.2);            // hub
    }
    function isHub(n) { return n.connections > 5; }
    // Precompute neighbor map — used for synapse highlights when a node is "fired"
    const neighborsOf = {};
    data.nodes.forEach(n => { neighborsOf[n.id] = new Set(); });
    data.links.forEach(l => {
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (neighborsOf[sId]) neighborsOf[sId].add(tId);
      if (neighborsOf[tId]) neighborsOf[tId].add(sId);
    });

    // ── Thinking-mode state — must be declared BEFORE Graph creation
    // because force-graph invokes linkColor/linkDirectionalParticles
    // synchronously during .graphData() and would otherwise hit TDZ.
    const thinkingActive = new Set();          // node ids currently being read (electric cyan)
    const thinkingAdjacent = new Set();        // 1-hop neighbors of active nodes (faint glow)
    const thinkingDoneOrder = new Map();       // node id → 1-based usage index (warm amber trail)
    let thinkingDoneCounter = 0;
    let thinkPulseTime = 0;
    const nodeById = {};
    data.nodes.forEach(n => { nodeById[n.id] = n; });
    function recomputeAdjacent() {
      thinkingAdjacent.clear();
      thinkingActive.forEach(id => {
        (neighborsOf[id] || new Set()).forEach(n => { if (!thinkingActive.has(n)) thinkingAdjacent.add(n); });
      });
    }
    function markDone(id) {
      if (!thinkingDoneOrder.has(id)) thinkingDoneOrder.set(id, ++thinkingDoneCounter);
    }
    function clearThinkingTrail() {
      thinkingActive.clear();
      thinkingAdjacent.clear();
      thinkingDoneOrder.clear();
      thinkingDoneCounter = 0;
    }

    const Graph = ForceGraph()(document.getElementById('graph'))
      .width(window.innerWidth)
      .height(window.innerHeight)
      .backgroundColor('#0a0a0a')
      .graphData(data)
      .nodeId('id')
      .nodeVal(n => nodeRadius(n) * 0.6)
      .nodeCanvasObject((node, ctx, globalScale) => {
        // (NOTE: this is the base renderer; thinking-mode renderer below overrides it.)
        renderNode(node, ctx, globalScale);
      })
      .nodePointerAreaPaint((node, color, ctx) => {
        const r = nodeRadius(node) + 6;
        ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color; ctx.fill();
      })
      .linkColor(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        const isSynapse = thinkingActive.has(sId) || thinkingActive.has(tId);
        const isTrail   = thinkingDoneOrder.has(sId) && thinkingDoneOrder.has(tId);
        if (isSynapse) return 'rgba(93,224,230,0.85)';
        if (isTrail)   return 'rgba(255,178,102,0.55)';
        if (highlightLinks.size > 0 && !highlightLinks.has(l)) return 'rgba(60,60,70,0.10)';
        return EDGE_COLOR[l.type] || 'rgba(255,255,255,0.08)';
      })
      .linkWidth(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        const isSynapse = thinkingActive.has(sId) || thinkingActive.has(tId);
        const isTrail   = thinkingDoneOrder.has(sId) && thinkingDoneOrder.has(tId);
        if (isSynapse) return 2.4;
        if (isTrail)   return 1.6;
        return highlightLinks.has(l) ? (EDGE_WIDTH[l.type] || 1) * 2 : (EDGE_WIDTH[l.type] || 1);
      })
      // Every link breathes a slow particle — synapse-active ones fire faster + brighter
      .linkDirectionalParticles(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (thinkingActive.has(sId) || thinkingActive.has(tId)) return 4;
        if (l.type === 'wikilink') return 2;
        if (l.type === 'mdlink')   return 1;
        return 0; // tag links stay quiet
      })
      .linkDirectionalParticleWidth(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        return (thinkingActive.has(sId) || thinkingActive.has(tId)) ? 2.4 : 1.4;
      })
      .linkDirectionalParticleSpeed(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        return (thinkingActive.has(sId) || thinkingActive.has(tId)) ? 0.018 : 0.005;
      })
      .linkDirectionalParticleColor(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (thinkingActive.has(sId) || thinkingActive.has(tId)) return SYNAPSE;
        return EDGE_COLOR[l.type] || '#7DA8E6';
      })
      .nodeVisibility(n => !(hideOrphans && n.connections === 0))
      .d3VelocityDecay(0.25)
      .warmupTicks(120)
      .cooldownTicks(1200)
      .onNodeHover(node => {
        hoverNode = node || null;
        // Sticky selection / active search win — when either is pinning the
        // highlight set, hover doesn't disturb it (Obsidian-style behavior).
        if (!stickyNode && !(searchActive && searchInput.value)) applyHighlight(hoverNode);
        document.body.style.cursor = node ? 'pointer' : 'grab';
        if (node) {
          tooltip.style.display = 'block';
          const tagsHtml = (node.tags || []).slice(0, 5).map(t => '<span class="t-tag">#' + t + '</span>').join('');
          tooltip.innerHTML =
            '<div class="t-name">' + (node.name || '(이름 없음)') + '</div>' +
            '<div class="t-meta">' + (node.folder || '/') + ' · ' + (node.connections || 0) + '개 연결</div>' +
            (tagsHtml ? '<div class="t-tags">' + tagsHtml + '</div>' : '');
        } else {
          tooltip.style.display = 'none';
        }
      })
      .onNodeRightClick(node => {
        vscode.postMessage({ type: 'openFile', id: node.id });
      });

    // ── Sticky selection (Obsidian signature behavior) ──
    // Single click → pin a node + its 1-hop neighbors as the highlight set
    //                (everything else dims).
    // Same node clicked again → unpin.
    // Different node clicked → repin.
    // Double-click → open file.
    // Background click → unpin.
    let stickyNode = null;
    function pinNode(node) {
      stickyNode = node;
      applyHighlight(node);
    }
    function unpinNode() {
      stickyNode = null;
      applyHighlight(hoverNode);  // fall back to hover state if any
    }

    let lastClick = { id: null, t: 0 };
    Graph.onNodeClick(node => {
      // Click during active search → close the search panel and act as a normal pin
      if (searchActive) closeSearch();
      const now = Date.now();
      if (lastClick.id === node.id && now - lastClick.t < 400) {
        // Double-click on the same node → open file
        vscode.postMessage({ type: 'openFile', id: node.id });
        lastClick = { id: null, t: 0 };
        return;
      }
      lastClick = { id: node.id, t: now };

      if (stickyNode && stickyNode.id === node.id) {
        unpinNode();
      } else {
        pinNode(node);
        Graph.centerAt(node.x, node.y, 600);
        Graph.zoom(3, 800);
      }
    });

    let lastBgClickT = 0;
    Graph.onBackgroundClick(() => {
      const now = Date.now();
      if (now - lastBgClickT < 400) {
        // Background double-click → reset zoom to fit the whole graph
        Graph.zoomToFit(800, 60);
        lastBgClickT = 0;
        return;
      }
      lastBgClickT = now;
      if (searchActive) closeSearch();
      else if (stickyNode) unpinNode();
    });

    // -- Search/filter bar (slash to open, ESC to close) --
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');
    let searchActive = false;
    function openSearch() {
      searchActive = true;
      searchBar.classList.add('active');
      searchInput.focus();
      searchInput.select();
    }
    function closeSearch() {
      searchActive = false;
      searchBar.classList.remove('active');
      searchInput.value = '';
      searchCount.textContent = '';
      searchCount.classList.remove('zero');
      // Restore prior state (sticky pin or current hover)
      applyHighlight(stickyNode || hoverNode);
    }
    function runSearch(q) {
      q = q.trim().toLowerCase();
      if (!q) {
        searchCount.textContent = '';
        searchCount.classList.remove('zero');
        applyHighlight(stickyNode || hoverNode);
        return;
      }
      const matches = new Set();
      data.nodes.forEach(n => {
        const hay = ((n.name || '') + ' ' + (n.folder || '') + ' ' +
                     (n.tags || []).map(t => '#' + t).join(' ')).toLowerCase();
        if (hay.includes(q)) matches.add(n.id);
      });
      searchCount.textContent = matches.size + '개';
      searchCount.classList.toggle('zero', matches.size === 0);
      if (matches.size === 0) {
        // Don't dim the whole graph for zero results — feels punishing
        highlightNodes = new Set(); highlightLinks = new Set();
        return;
      }
      highlightNodes = new Set(matches);
      highlightLinks = new Set();
      data.links.forEach(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (matches.has(sId) && matches.has(tId)) highlightLinks.add(l);
      });
    }
    searchInput.addEventListener('input', () => runSearch(searchInput.value));
    document.addEventListener('keydown', (e) => {
      if (e.target === searchInput) {
        if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
        return;
      }
      if (e.key === '/' && !searchActive) {
        e.preventDefault();
        openSearch();
      } else if (e.key === 'Escape' && searchActive) {
        closeSearch();
      }
    });

    // Force tuning: hubs repel more (so they sit at cluster centers naturally),
    // tag-only links are weaker so they don't dominate the layout, and a gentle
    // center pull keeps orphans on-screen.
    const sparseFactor = Math.max(0.4, Math.min(1, data.links.length / Math.max(1, data.nodes.length)));
    Graph.d3Force('charge').strength(n => -50 - 25 * sparseFactor - (isHub(n) ? 60 : 0));
    Graph.d3Force('link')
      .distance(l => l.type === 'tag' ? 90 : l.type === 'mdlink' ? 50 : 36)
      .strength(l => l.type === 'tag' ? 0.15 : l.type === 'mdlink' ? 0.5 : 0.85);
    if (typeof window.d3 !== 'undefined' && window.d3.forceCenter) {
      Graph.d3Force('center', window.d3.forceCenter(0, 0).strength(0.06));
    }

    // Tooltip follow mouse
    document.addEventListener('mousemove', (e) => {
      if (tooltip.style.display === 'block') {
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top = (e.clientY + 14) + 'px';
      }
    });

    // Multi-stage zoom-to-fit: gives the layout time to settle, then frames it nicely.
    // Padding scales with node count so dense graphs use more space and sparse ones tighten in.
    const zoomPad = data.nodes.length < 10 ? 100 : data.nodes.length < 30 ? 70 : 40;
    setTimeout(() => Graph.zoomToFit(800, zoomPad), 400);
    setTimeout(() => {
      Graph.zoomToFit(1200, zoomPad);
      document.getElementById('titleSpan').innerText = '지식 네트워크 · LIVE';
    }, 1500);
    // Final settle once cooldown completes
    setTimeout(() => Graph.zoomToFit(1200, zoomPad), 3000);

    window.addEventListener('resize', () => {
      Graph.width(window.innerWidth).height(window.innerHeight);
    });

    // ============================================================
    // 🎬 THINKING MODE — receive realtime events from chat extension
    // ============================================================
    const thinkingOverlay = document.getElementById('thinking-overlay');
    const phaseContext = document.getElementById('phase-context');
    const phaseBrain = document.getElementById('phase-brain');
    const phaseAnswer = document.getElementById('phase-answer');
    const answerPreview = document.getElementById('answer-preview');

    // Map basename → node for fast lookup when AI sends "read this brain note"
    const nodesByBasename = {};
    data.nodes.forEach(n => {
      const k = n.name.toLowerCase();
      nodesByBasename[k] = nodesByBasename[k] || [];
      nodesByBasename[k].push(n);
    });
    function findNodeForReadRequest(req) {
      if (typeof req !== 'string' || !req) return null;
      // Try by exact id first
      const direct = data.nodes.find(n => n.id === req || n.id === req + '.md');
      if (direct) return direct;
      // Then by basename match
      const base = (req.split(/[\\\\/]/).pop() || '').replace(/\\.md$/i, '').toLowerCase();
      const matches = nodesByBasename[base];
      return matches && matches.length > 0 ? matches[0] : null;
    }

    // (thinkingActive / thinkingAdjacent / thinkingDone / recomputeAdjacent
    //  were hoisted above the Graph constructor to avoid TDZ when force-graph
    //  invokes link callbacks synchronously during .graphData().)

    // Single canonical renderer — Obsidian + brain look, thinking effects layered on top.
    function renderNode(node, ctx, globalScale) {
      // Skip the very first ticks before force-graph has assigned coords —
      // createRadialGradient throws if any value is non-finite.
      if (!isFinite(node.x) || !isFinite(node.y)) return;
      const baseR = Math.max(1, nodeRadius(node) || 0);
      const isHL = highlightNodes.size === 0 || highlightNodes.has(node.id);
      const isActive = thinkingActive.has(node.id);
      const isAdj    = thinkingAdjacent.has(node.id);
      const isDone   = thinkingDoneOrder.has(node.id);
      const isOrphan = node.connections === 0;
      const hub      = isHub(node);
      const color    = folderColor[node.folder] || '#9aa0a6';

      // ── 1. Active synapse halo: pulsing electric cyan ──
      if (isActive) {
        const pulse = 0.5 + 0.5 * Math.sin(thinkPulseTime * 0.09);
        const haloR = baseR * (2.6 + pulse * 0.9);
        const grad = ctx.createRadialGradient(node.x, node.y, baseR, node.x, node.y, haloR);
        grad.addColorStop(0, 'rgba(93,224,230,0.55)');
        grad.addColorStop(0.5, 'rgba(93,224,230,0.20)');
        grad.addColorStop(1,  'rgba(93,224,230,0)');
        ctx.beginPath(); ctx.arc(node.x, node.y, haloR, 0, 2 * Math.PI);
        ctx.fillStyle = grad; ctx.fill();
      }

      // ── 2. Adjacent ghost glow: faint cyan whisper ──
      if (isAdj && !isActive) {
        ctx.beginPath(); ctx.arc(node.x, node.y, baseR * 1.8, 0, 2 * Math.PI);
        const g = ctx.createRadialGradient(node.x, node.y, baseR * 0.6, node.x, node.y, baseR * 1.8);
        g.addColorStop(0, 'rgba(93,224,230,0.22)');
        g.addColorStop(1, 'rgba(93,224,230,0)');
        ctx.fillStyle = g; ctx.fill();
      }

      // ── 3. Ambient glow for hubs / done-trail ──
      const r = isHL ? baseR : baseR * 0.7;
      const ambientColor = isActive ? SYNAPSE : isDone ? TRAIL : color;
      const ambientStrength = isActive ? 'cc' : isDone ? '99' : (hub && isHL ? '88' : (isHL ? '55' : '22'));
      ctx.beginPath(); ctx.arc(node.x, node.y, r + (hub ? 5 : 3), 0, 2 * Math.PI);
      const ambient = ctx.createRadialGradient(node.x, node.y, r * 0.4, node.x, node.y, r + (hub ? 5 : 3));
      ambient.addColorStop(0, ambientColor + ambientStrength);
      ambient.addColorStop(1, ambientColor + '00');
      ctx.fillStyle = ambient; ctx.fill();

      // ── 4. Solid core ──
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      if (isActive) {
        ctx.shadowBlur = 24; ctx.shadowColor = SYNAPSE;
        ctx.fillStyle = SYNAPSE; ctx.fill();
      } else if (isDone) {
        ctx.shadowBlur = 12; ctx.shadowColor = TRAIL;
        ctx.fillStyle = TRAIL; ctx.fill();
      } else if (isOrphan) {
        ctx.fillStyle = '#0a0a0a'; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = color + (isHL ? 'a0' : '50'); ctx.stroke();
      } else if (hub && isHL) {
        ctx.shadowBlur = 14; ctx.shadowColor = color;
        ctx.fillStyle = color; ctx.fill();
      } else {
        ctx.fillStyle = isHL ? color : color + '88'; ctx.fill();
      }
      ctx.shadowBlur = 0;

      // ── 5. Zoom-aware label ──
      // Obsidian behavior: only hubs always show; mids appear as you zoom in;
      // leaves only at high zoom. Active/done nodes always show their name.
      const labelMinScale = isActive || isDone ? 0 : hub ? 0 : node.connections >= 2 ? 1.4 : 2.6;
      if (globalScale < labelMinScale) return;

      const fs = isActive || isDone || hub
        ? Math.max(4, Math.min(8, 13 / globalScale + (hub ? 1.5 : 0)))
        : Math.max(3, Math.min(6, 11 / globalScale));
      const fontWeight = isActive ? '700 ' : (hub || isDone) ? '600 ' : '';
      ctx.font = fontWeight + fs + "px -apple-system, 'SF Pro Display', sans-serif";
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';

      const dimAlpha = highlightNodes.size > 0 && !isHL ? '40' : '';
      ctx.fillStyle = isActive ? SYNAPSE
                    : isDone   ? TRAIL
                    : hub      ? '#f0f0f0' + dimAlpha
                    :            '#a0a0a8' + dimAlpha;
      // subtle text shadow for active/hub legibility
      if (isActive || isDone) { ctx.shadowBlur = 6; ctx.shadowColor = isActive ? SYNAPSE : TRAIL; }
      ctx.fillText(node.name || '', node.x, node.y + r + 2);
      ctx.shadowBlur = 0;

      // ── 6. Usage-order index chip on cited nodes (1, 2, 3...) ──
      if (isDone) {
        const idx = thinkingDoneOrder.get(node.id);
        if (idx) {
          const chipR = Math.max(4.5, 6 / globalScale);
          const cx = node.x + r + chipR + 1;
          const cy = node.y - r - 1;
          ctx.beginPath(); ctx.arc(cx, cy, chipR, 0, 2 * Math.PI);
          ctx.fillStyle = TRAIL; ctx.fill();
          ctx.lineWidth = 0.6; ctx.strokeStyle = '#131419'; ctx.stroke();
          ctx.fillStyle = '#131419';
          ctx.font = '700 ' + Math.max(5, 7 / globalScale) + "px -apple-system, sans-serif";
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(idx), cx, cy + 0.5);
        }
      }
    }

    // Re-bind renderer (override of the placeholder bound earlier).
    Graph.nodeCanvasObject(renderNode);

    // ── Trail path: dashed amber line connecting cited nodes in usage order ──
    Graph.onRenderFramePost((ctx) => {
      if (thinkingDoneOrder.size < 2) return;
      const ordered = [...thinkingDoneOrder.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => nodeById[id])
        .filter(n => n && isFinite(n.x) && isFinite(n.y));
      if (ordered.length < 2) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,178,102,0.45)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ordered.forEach((n, i) => {
        if (i === 0) ctx.moveTo(n.x, n.y);
        else ctx.lineTo(n.x, n.y);
      });
      ctx.stroke();
      ctx.restore();
    });

    // Pulse animation tick — drive both thinking pulse and a slow ambient breath.
    setInterval(() => {
      thinkPulseTime++;
      // Force redraw only when there's an active animation to avoid wasted work.
      if (thinkingActive.size > 0 || thinkingAdjacent.size > 0) {
        Graph.nodeRelSize(Graph.nodeRelSize());
      }
    }, 40);

    function setPhase(id, state) {
      const el = document.getElementById('phase-' + id);
      if (!el) return;
      el.classList.remove('active', 'done');
      if (state) el.classList.add(state);
    }

    function showThinkingOverlay() {
      thinkingOverlay.classList.add('active');
      document.body.classList.add('thinking');
    }
    function hideThinkingOverlay() {
      // Keep the thinking trail visible (done nodes stay highlighted) but remove pulse overlay
      document.body.classList.remove('thinking');
      // Auto-hide overlay after a delay so user can see the final state
      setTimeout(() => {
        thinkingOverlay.classList.remove('active');
        thinkingActive.clear();
      }, 6000);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'thinking_start': {
          showThinkingOverlay();
          phaseContext.querySelector('.text').textContent = '컨텍스트 모으는 중...';
          phaseBrain.querySelector('.text').textContent = '관련 노트 찾는 중...';
          phaseAnswer.querySelector('.text').textContent = '답변 생성 중...';
          setPhase('context', 'active'); setPhase('brain', null); setPhase('answer', null);
          answerPreview.style.display = 'none';
          answerPreview.textContent = '';
          clearThinkingTrail();   // fresh session — drop the previous trail entirely
          break;
        }
        case 'context_done': {
          const summary = (msg.workspace ? '📂 워크스페이스' : '') +
                          (msg.brainCount > 0 ? '  🧠 ' + msg.brainCount + '개 노트' : '') +
                          (msg.web ? '  🌐 인터넷' : '');
          phaseContext.querySelector('.text').textContent = '컨텍스트 모음 완료' + (summary ? ' · ' + summary : '');
          setPhase('context', 'done');
          setPhase('brain', 'active');
          break;
        }
        case 'brain_read': {
          const node = findNodeForReadRequest(msg.note || '');
          if (node) {
            thinkingActive.add(node.id);
            recomputeAdjacent();
            // Camera nudge — gently center on the active node
            try { Graph.centerAt(node.x, node.y, 800); } catch(e){}
            phaseBrain.querySelector('.text').textContent = '🧠 ' + (node.name || '(노트)') + ' 읽는 중...';
            // After 1.4s, mark as done (trail) and remove from active
            setTimeout(() => {
              thinkingActive.delete(node.id);
              markDone(node.id);
              recomputeAdjacent();
            }, 1400);
          } else {
            phaseBrain.querySelector('.text').textContent = '🧠 ' + (msg.note || '...') + ' 검색 중...';
          }
          break;
        }
        case 'url_read': {
          phaseBrain.querySelector('.text').textContent = '🌐 ' + (msg.url || '').slice(0, 60) + '...';
          break;
        }
        case 'answer_start': {
          setPhase('brain', 'done');
          setPhase('answer', 'active');
          answerPreview.style.display = 'block';
          break;
        }
        case 'answer_chunk': {
          // Show last ~120 chars as live preview
          if (typeof msg.text === 'string') {
            answerPreview.textContent = (answerPreview.textContent + msg.text).slice(-180);
          }
          break;
        }
        case 'answer_complete': {
          setPhase('answer', 'done');
          phaseAnswer.querySelector('.text').textContent = '✅ 답변 완료';
          if (Array.isArray(msg.sources)) {
            msg.sources.forEach(req => {
              const node = findNodeForReadRequest(req);
              if (node) markDone(node.id);
            });
          }
          hideThinkingOverlay();
          // Auto-frame the cluster of cited notes — "this answer came from
          // these notes" — so the trail isn't lost in a sea of unrelated nodes.
          // Falls back to full-graph fit when nothing was cited.
          setTimeout(() => {
            if (thinkingDoneOrder.size > 0) {
              try {
                Graph.zoomToFit(1200, 120, n => thinkingDoneOrder.has(n.id));
              } catch(e){ Graph.zoomToFit(1000, 80); }
            } else {
              Graph.zoomToFit(1000, 80);
            }
          }, 400);
          break;
        }
        case 'highlight_node': {
          // External request to focus on a specific note (citation badge click)
          const node = findNodeForReadRequest(msg.note || '');
          if (node) {
            markDone(node.id);
            try { Graph.centerAt(node.x, node.y, 600); Graph.zoom(3, 800); } catch(e){}
            applyHighlight(node);
          }
          break;
        }
        case 'graphData': {
          // Live refresh — new knowledge was injected (EZER / A.U Training).
          // Replace data + tell force-graph to layout incrementally so existing
          // nodes keep their positions and only new nodes settle in.
          if (!msg.data || !Array.isArray(msg.data.nodes)) break;
          data.nodes = msg.data.nodes;
          data.links = msg.data.links || [];
          // Refresh derived lookups
          for (const k in nodeById) delete nodeById[k];
          data.nodes.forEach(n => { nodeById[n.id] = n; });
          for (const k in neighborsOf) delete neighborsOf[k];
          data.nodes.forEach(n => { neighborsOf[n.id] = new Set(); });
          data.links.forEach(l => {
            const sId = (l.source && l.source.id) || l.source;
            const tId = (l.target && l.target.id) || l.target;
            if (neighborsOf[sId]) neighborsOf[sId].add(tId);
            if (neighborsOf[tId]) neighborsOf[tId].add(sId);
          });
          for (const k in nodesByBasename) delete nodesByBasename[k];
          data.nodes.forEach(n => {
            const k = (n.name || '').toLowerCase();
            nodesByBasename[k] = nodesByBasename[k] || [];
            nodesByBasename[k].push(n);
          });
          // Push new graph data into force-graph
          Graph.graphData(data);
          // Stats refresh
          const newFolders = [...new Set(data.nodes.map(n => n.folder))].sort();
          newFolders.forEach((f, i) => { if (!folderColor[f]) folderColor[f] = PALETTE[i % PALETTE.length]; });
          document.getElementById('stats').textContent =
            data.nodes.length + ' 지식 · ' + data.links.length + ' 연결 · ' + newFolders.length + ' 폴더';
          // Append any newly seen folders to legend chip list
          const folderListEl = document.getElementById('folders-list');
          if (folderListEl) {
            const existing = new Set([...folderListEl.querySelectorAll('.folder-name')].map(el => el.textContent));
            const counts = {};
            data.nodes.forEach(n => { counts[n.folder] = (counts[n.folder] || 0) + 1; });
            newFolders.forEach(f => {
              if (existing.has(f || '/')) return;
              const row = document.createElement('div');
              row.className = 'folder-row';
              const dot = document.createElement('div');
              dot.className = 'folder-dot';
              dot.style.background = folderColor[f] || '#888';
              const name = document.createElement('div');
              name.className = 'folder-name';
              name.textContent = f || '/';
              const count = document.createElement('div');
              count.className = 'folder-count';
              count.textContent = counts[f] || 0;
              row.appendChild(dot); row.appendChild(name); row.appendChild(count);
              folderListEl.appendChild(row);
            });
          }
          // Pulse the freshly injected node so the user actually sees it
          if (msg.highlightTitle) {
            const node = findNodeForReadRequest(msg.highlightTitle);
            if (node) {
              thinkingActive.add(node.id);
              recomputeAdjacent();
              try { Graph.centerAt(node.x || 0, node.y || 0, 800); Graph.zoom(2.4, 900); } catch(e){}
              setTimeout(() => {
                thinkingActive.delete(node.id);
                markDone(node.id);
                recomputeAdjacent();
              }, 2200);
            }
          }
          break;
        }
      }
    });

    // Notify extension we're ready to receive events
    vscode.postMessage({ type: 'graph_ready' });
  </script>
</body>
</html>`;
}

export function deactivate() {}

// ============================================================
// 🏢 OfficePanel — Smallville-style virtual office (full-screen)
// ============================================================
class OfficePanel {
    public static current?: OfficePanel;
    private static readonly viewType = 'connectAiOffice';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _ctx: vscode.ExtensionContext;
    private readonly _provider: SidebarChatProvider;
    private _disposables: vscode.Disposable[] = [];

    static createOrShow(ctx: vscode.ExtensionContext, provider: SidebarChatProvider) {
        if (OfficePanel.current) {
            OfficePanel.current._panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        try { provider.broadcastOfficeState(true); } catch { /* ignore */ }
        const userAssets = OfficePanel._resolveUserAssetsPath();
        const localResourceRoots: vscode.Uri[] = [ctx.extensionUri];
        if (userAssets) {
            localResourceRoots.push(vscode.Uri.file(userAssets));
        }
        // Allow loading user's custom map PNG from the brain folder
        try {
            const brain = getCompanyDir();
            if (brain && fs.existsSync(brain)) {
                localResourceRoots.push(vscode.Uri.file(brain));
            }
        } catch { /* ignore */ }
        const panel = vscode.window.createWebviewPanel(
            OfficePanel.viewType,
            '🏢 가상 사무실',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots
            }
        );
        OfficePanel.current = new OfficePanel(panel, ctx, provider);
    }

    private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, provider: SidebarChatProvider) {
        this._panel = panel;
        this._ctx = ctx;
        this._provider = provider;

        provider.registerCorporateBroadcastTarget(panel.webview);

        panel.onDidDispose(() => this.dispose(), null, this._disposables);
        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'officeReady':
                    this._sendInit();
                    break;
                case 'officePrompt': {
                    const prompt = String(msg.value || '').trim();
                    if (!prompt) return;
                    const model = provider.getDefaultModel();
                    provider.runCorporatePromptExternal(prompt, model).catch((e) => {
                        try { panel.webview.postMessage({ type: 'error', value: `⚠️ ${e?.message || e}` }); } catch { /* ignore */ }
                    });
                    break;
                }
                case 'runChatter': {
                    const model = provider.getDefaultModel();
                    provider.runAutonomousChatter(model).catch(() => { /* silent */ });
                    break;
                }
                case 'loadConversations': {
                    try {
                        const convDir = getConversationsDir();
                        const today = new Date().toISOString().slice(0, 10);
                        const f = path.join(convDir, `${today}.md`);
                        const content = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : `_아직 오늘 대화가 없습니다._\n\n경로: ${convDir.replace(os.homedir(), '~')}/${today}.md`;
                        panel.webview.postMessage({ type: 'conversationsLoaded', date: today, content });
                    } catch (e: any) {
                        panel.webview.postMessage({ type: 'conversationsLoaded', date: '', content: `_읽기 실패: ${e?.message || e}_` });
                    }
                    break;
                }
                case 'setRoom': {
                    const roomId = String(msg.roomId || '').trim();
                    if (!ROOMS.find(r => r.id === roomId)) break;
                    try { await this._ctx.globalState.update('officeRoomId', roomId); } catch { /* ignore */ }
                    this._broadcastRoom(roomId);
                    break;
                }
                case 'openCompanyFolder':
                    try {
                        const dir = ensureCompanyStructure();
                        const sub = msg.sub || '';
                        const target = sub ? path.join(dir, sub) : dir;
                        vscode.env.openExternal(vscode.Uri.file(target));
                    } catch { /* ignore */ }
                    break;
                case 'pickCompanyFolder': {
                    try {
                        const picked = await vscode.window.showOpenDialog({
                            canSelectFolders: true,
                            canSelectFiles: false,
                            canSelectMany: false,
                            openLabel: '회사 폴더로 선택',
                            title: '회사 폴더 선택 — 에이전트들의 작업/메모리/세션이 여기에 저장됩니다'
                        });
                        if (!picked || picked.length === 0) break;
                        const newDir = picked[0].fsPath;
                        await setCompanyDir(newDir);
                        ensureCompanyStructure();
                        this._sendInit();
                        this._panel.webview.postMessage({ type: 'companyFolderChanged', dir: newDir.replace(os.homedir(), '~') });
                        vscode.window.showInformationMessage(`🏢 회사 폴더 변경됨: ${newDir}`);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`폴더 변경 실패: ${e?.message || e}`);
                    }
                    break;
                }
                case 'agentProfileRequest': {
                    try {
                        const id = String(msg.agent || '');
                        const dir = ensureCompanyStructure();
                        const agentDir = path.join(dir, '_agents', id);
                        const memoryPath = path.join(agentDir, 'memory.md');
                        const decisionsPath = path.join(agentDir, 'decisions.md');
                        const memory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8').slice(0, 4000) : '_메모리 없음_';
                        const decisions = fs.existsSync(decisionsPath) ? fs.readFileSync(decisionsPath, 'utf-8').slice(-3000) : '_의사결정 기록 없음_';
                        /* count session files mentioning this agent */
                        const sessionsRoot = path.join(dir, 'sessions');
                        let sessionCount = 0;
                        let recentSessions: string[] = [];
                        if (fs.existsSync(sessionsRoot)) {
                            const entries = fs.readdirSync(sessionsRoot).filter(n => fs.statSync(path.join(sessionsRoot, n)).isDirectory());
                            recentSessions = entries.sort().slice(-5).reverse();
                            sessionCount = entries.length;
                        }
                        this._panel.webview.postMessage({
                            type: 'agentProfile',
                            agent: id,
                            memory, decisions,
                            sessionCount,
                            recentSessions,
                            agentDir: agentDir.replace(os.homedir(), '~')
                        });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentProfile', agent: msg.agent, error: e?.message || String(e) });
                    }
                    break;
                }
                case 'agentConfigRequest': {
                    try {
                        const id = String(msg.agent || '');
                        const dir = ensureCompanyStructure();
                        const connPath = path.join(dir, '_agents', id, 'connections.md');
                        const values: Record<string, string> = {};
                        if (fs.existsSync(connPath)) {
                            const text = fs.readFileSync(connPath, 'utf-8');
                            /* Parse simple "- key: value" lines (also tolerates "key: value") */
                            text.split('\n').forEach(line => {
                                const m2 = line.match(/^[\s-]*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$/);
                                if (m2) values[m2[1]] = m2[2];
                            });
                        }
                        this._panel.webview.postMessage({ type: 'agentConfig', agent: id, values });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentConfig', agent: msg.agent, values: {}, error: e?.message || String(e) });
                    }
                    break;
                }
                case 'saveAgentConfig': {
                    try {
                        const id = String(msg.agent || '');
                        const dir = ensureCompanyStructure();
                        const agentDir = path.join(dir, '_agents', id);
                        if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
                        const connPath = path.join(agentDir, 'connections.md');
                        const values = (msg.values || {}) as Record<string, string>;
                        const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
                        const lines = [
                            `# ${id} — 외부 연결 / API 설정`,
                            ``,
                            `> 마지막 수정: ${ts}`,
                            `> 이 파일은 ${id} 에이전트가 작업할 때 자동으로 읽힙니다. 민감한 토큰은 git에서 제외(.gitignore)되도록 주의하세요.`,
                            ``,
                            `## 연결 정보`,
                            ``
                        ];
                        Object.keys(values).forEach(k => {
                            const v = (values[k] || '').trim();
                            if (v) lines.push(`- ${k}: ${v}`);
                        });
                        fs.writeFileSync(connPath, lines.join('\n') + '\n', 'utf-8');
                        this._panel.webview.postMessage({ type: 'agentConfigSaved', agent: id });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentConfigSaved', agent: msg.agent, error: e?.message || String(e) });
                    }
                    break;
                }
            }
        }, null, this._disposables);

        panel.webview.html = this._renderHtml();
    }

    /** 사용자가 설정에 명시적으로 추가 자산 경로를 지정한 경우만 사용. 그 외엔 vsix 번들 자산 사용. */
    private static _resolveUserAssetsPath(): string {
        const cfg = vscode.workspace.getConfiguration('connectAiLab');
        const explicit = (cfg.get<string>('assetsPath') || '').trim();
        if (explicit && fs.existsSync(explicit)) return explicit;
        // Dev mode: extension repo includes the LimeZu pack at
        // `assets/pixel/moderninteriors-win` (excluded from vsix via .vscodeignore).
        if (_extCtx) {
            const dev = path.join(_extCtx.extensionPath, 'assets', 'pixel', 'moderninteriors-win');
            if (fs.existsSync(dev)) return dev;
        }
        return '';
    }

    /** 캐릭터 sprite를 결정. 우선순위: 사용자 LimeZu 폴더 > 번들 자산 > 빈 문자열(이모지 폴백) */
    private _resolveCharacterSprite(agentId: string): { uri: string; source: 'user' | 'bundled' | 'none' } {
        const userPath = OfficePanel._resolveUserAssetsPath();
        if (userPath) {
            const idx: Record<string, number> = {
                ceo: 1, youtube: 2, instagram: 3, designer: 4,
                developer: 5, business: 6, secretary: 7
            };
            const num = idx[agentId];
            if (num) {
                const padded = String(num).padStart(2, '0');
                const candidates = [
                    // Real LimeZu folder structure
                    path.join(userPath, '2_Characters', 'Character_Generator', '0_Premade_Characters', '48x48', `Premade_Character_48x48_${padded}.png`),
                    // Legacy/flattened layout
                    path.join(userPath, 'modern-interiors', 'characters', `Premade_Character_48x48_${padded}.png`),
                ];
                for (const file of candidates) {
                    if (fs.existsSync(file)) {
                        return { uri: this._panel.webview.asWebviewUri(vscode.Uri.file(file)).toString(), source: 'user' };
                    }
                }
            }
        }
        // 번들 자산 (vsix에 포함, 모든 사용자에게 동작)
        const bundled = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'characters', `${agentId}.png`);
        if (fs.existsSync(bundled.fsPath)) {
            return { uri: this._panel.webview.asWebviewUri(bundled).toString(), source: 'bundled' };
        }
        return { uri: '', source: 'none' };
    }

    /** Resolve all WORLD_LAYOUT scene + decoration assets to webview URIs.
     *  Returns the data shape the webview officeInit handler expects. */
    private _resolveWorld(): {
        worldWidth: number;
        worldHeight: number;
        grassUri: string;
        pathUri: string;
        paths: Array<{ x: number; y: number; w: number; h: number; }>;
        buildings: Array<{ id: string; layer1Uri: string; layer2Uri: string; x: number; y: number; width: number; height: number; }>;
        decorations: Array<{ uri: string; x: number; y: number; w?: number; }>;
        desks: Record<string, DeskPos>;
        zones: WorldZone[];
    } {
        const officeDir = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'office');
        const gardenDir = vscode.Uri.joinPath(officeDir, 'garden');
        const toUri = (root: vscode.Uri, file: string) => {
            if (!file) return '';
            const fp = vscode.Uri.joinPath(root, file);
            if (!fs.existsSync(fp.fsPath)) return '';
            return this._panel.webview.asWebviewUri(fp).toString();
        };
        const buildings = WORLD_LAYOUT.buildings.map(b => ({
            id: b.id,
            layer1Uri: toUri(officeDir, b.layer1),
            layer2Uri: toUri(officeDir, b.layer2 || ''),
            x: b.x, y: b.y, width: b.width, height: b.height,
        }));
        const decorations = WORLD_LAYOUT.decorations
            .map(d => ({ uri: toUri(gardenDir, d.file), x: d.x, y: d.y, w: d.w }))
            .filter(d => !!d.uri);
        return {
            worldWidth: WORLD_LAYOUT.worldWidth,
            worldHeight: WORLD_LAYOUT.worldHeight,
            grassUri: toUri(gardenDir, 'grass_base.png'),
            pathUri: toUri(gardenDir, 'path_stone.png'),
            paths: WORLD_LAYOUT.paths,
            buildings,
            decorations,
            desks: buildWorldDeskPositions(),
            zones: WORLD_LAYOUT.zones,
        };
    }

    /** 룸의 floor/furniture PNG URI를 결정. (Phase-2 단일 오피스 모드에선 미사용 — 레거시 setRoom 핸들러용으로만 남겨둠.) */
    private _resolveRoomAssets(room: RoomDef): { floorUri: string; furnitureUri: string } {
        const userPath = OfficePanel._resolveUserAssetsPath();
        if (userPath && room.layerFolder) {
            const dir = path.join(userPath, '6_Home_Designs', room.layerFolder, '48x48');
            if (fs.existsSync(dir)) {
                try {
                    const files = fs.readdirSync(dir);
                    const findLayer = (n: number): string => {
                        const re = new RegExp(`^${room.layerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*_layer_${n}_48x48\\.png$`, 'i');
                        return files.find(f => re.test(f)) || '';
                    };
                    const f1 = findLayer(1);
                    const f2 = findLayer(2);
                    if (f1) {
                        const floorUri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(dir, f1))).toString();
                        const furnitureUri = f2
                            ? this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(dir, f2))).toString()
                            : '';
                        return { floorUri, furnitureUri };
                    }
                } catch { /* fall through to bundled */ }
            }
        }
        // 번들 폴백 — TV 스튜디오 단일 룸. 모든 사용자에게 최소한의 룸 보장.
        const floorBundled = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'interior', 'floor.png');
        const furnitureBundled = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'interior', 'furniture.png');
        return {
            floorUri: fs.existsSync(floorBundled.fsPath) ? this._panel.webview.asWebviewUri(floorBundled).toString() : '',
            furnitureUri: fs.existsSync(furnitureBundled.fsPath) ? this._panel.webview.asWebviewUri(furnitureBundled).toString() : '',
        };
    }

    /** Resolve LimeZu animated GIF URIs for a room. Each entry returns a uri
     *  the webview can render, plus its position metadata. Animations live in
     *  `<userPath>/3_Animated_objects/48x48/gif/animated_<name>_48x48.gif`. */
    private _resolveAnimationUris(room: RoomDef): Array<{ src: string; x: number; y: number; w: number }> {
        if (!room.animations || room.animations.length === 0) return [];
        const userPath = OfficePanel._resolveUserAssetsPath();
        if (!userPath) return [];
        const dir = path.join(userPath, '3_Animated_objects', '48x48', 'gif');
        if (!fs.existsSync(dir)) return [];
        const out: Array<{ src: string; x: number; y: number; w: number }> = [];
        for (const a of room.animations) {
            const file = path.join(dir, `animated_${a.gifName}_48x48.gif`);
            if (!fs.existsSync(file)) continue;
            out.push({
                src: this._panel.webview.asWebviewUri(vscode.Uri.file(file)).toString(),
                x: a.x,
                y: a.y,
                w: a.w || 9.1,
            });
        }
        return out;
    }

    private _activeRoomId(): string {
        const saved = (this._ctx.globalState.get<string>('officeRoomId') || '').trim();
        if (saved && ROOMS.find(r => r.id === saved)) return saved;
        return DEFAULT_ROOM_ID;
    }

    /** Detect a user-supplied office map (PNG/JPG/JPEG). If present, the webview
     *  replaces the procedural WORLD_LAYOUT (grass + buildings + decor) with this
     *  single full-stage image. Useful for AI-generated or hand-drawn full-floor maps.
     *  Search order: brain dir _world/, brain dir root, then extension assets/. */
    private _resolveCustomOfficeMap(): string {
        try {
            const brain = getCompanyDir();
            const extAssets = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets').fsPath;
            const candidates = [
                path.join(brain, '_world', 'office-map.png'),
                path.join(brain, '_world', 'office-map.jpg'),
                path.join(brain, '_world', 'office-map.jpeg'),
                path.join(brain, 'office-map.png'),
                path.join(brain, 'office-map.jpg'),
                path.join(brain, 'office-map.jpeg'),
                path.join(extAssets, 'office-map.png'),
                path.join(extAssets, 'office-map.jpg'),
                path.join(extAssets, 'office-map.jpeg'),
                path.join(extAssets, 'map.png'),
                path.join(extAssets, 'map.jpg'),
                path.join(extAssets, 'map.jpeg'),
            ];
            for (const file of candidates) {
                if (fs.existsSync(file)) {
                    return this._panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
                }
            }
        } catch { /* ignore */ }
        return '';
    }

    private _availableRooms(): RoomDef[] {
        // Always return all 6 rooms so the floor-plan grid always has 6 cells.
        // Rooms whose LimeZu PNG can't be resolved fall back to the bundled
        // TV-studio image — repeated visuals are a clear hint to set assetsPath.
        return ROOMS;
    }

    /** Each agent's primary room. PRIMARY_ROOM map wins; fall back to first
     *  room in `rooms` that lists the agent; final fallback = rooms[0]. */
    private _buildAgentRoomMap(rooms: RoomDef[]): Record<string, string> {
        const ids = new Set(rooms.map(r => r.id));
        const map: Record<string, string> = {};
        for (const id of AGENT_ORDER) {
            const preferred = PRIMARY_ROOM[id];
            if (preferred && ids.has(preferred)) { map[id] = preferred; continue; }
            for (const r of rooms) {
                if (r.agents.includes(id)) { map[id] = r.id; break; }
            }
            if (!map[id]) map[id] = rooms[0].id;
        }
        return map;
    }

    /** Convert per-room home positions into a single global %-of-floor coord
     *  space, based on each room's slot in the 3×2 floor-plan grid. */
    private _buildGlobalHomePos(
        rooms: RoomDef[],
        agentRoomMap: Record<string, string>,
    ): Record<string, { x: number; y: number }> {
        const COLS = 3, ROWS = 2;
        const COL_W = 100 / COLS;
        const ROW_H = 100 / ROWS;
        const out: Record<string, { x: number; y: number }> = {};
        for (const id of AGENT_ORDER) {
            const roomId = agentRoomMap[id];
            const idx = rooms.findIndex(r => r.id === roomId);
            if (idx < 0) { out[id] = { x: 50, y: 50 }; continue; }
            const col = idx % COLS;
            const row = Math.floor(idx / COLS);
            const local = (rooms[idx].homePos || {})[id] || { x: 50, y: 60 };
            out[id] = {
                x: col * COL_W + (local.x / 100) * COL_W,
                y: row * ROW_H + (local.y / 100) * ROW_H,
            };
        }
        return out;
    }

    /** Full floor-plan data: every available room with floor/furniture/animation URIs and home positions. */
    private _buildAllRoomsData() {
        const rooms = this._availableRooms();
        return rooms.map(r => {
            const { floorUri, furnitureUri } = this._resolveRoomAssets(r);
            const animations = this._resolveAnimationUris(r);
            return {
                id: r.id,
                name: r.name,
                emoji: r.emoji,
                floorUri,
                furnitureUri,
                animations,
                agents: r.agents,
                homePos: r.homePos,
            };
        });
    }

    private _sendInit() {
        const characterUris: Record<string, string> = {};
        const sources: Record<string, string> = {};
        let firstUri = '';
        const missing: string[] = [];
        for (const id of AGENT_ORDER) {
            const r = this._resolveCharacterSprite(id);
            if (r.uri) {
                characterUris[id] = r.uri;
                sources[id] = r.source;
                if (!firstUri) firstUri = r.uri;
            } else {
                missing.push(id);
            }
        }
        const agents = AGENT_ORDER.map(id => ({
            id,
            name: AGENTS[id].name,
            role: AGENTS[id].role,
            emoji: AGENTS[id].emoji,
            color: AGENTS[id].color,
            specialty: AGENTS[id].specialty,
            sprite: characterUris[id] || ''
        }));
        const dir = getCompanyDir();
        const userPath = OfficePanel._resolveUserAssetsPath();
        const bundledCount = Object.values(sources).filter(s => s === 'bundled').length;
        const userCount = Object.values(sources).filter(s => s === 'user').length;
        // Phase-B-1 connected campus: Office + Cafe + Garden in one world.
        // If user dropped a custom full-stage map (e.g. assets/map.jpeg),
        // that single PNG replaces the procedural world (grass + buildings + decor)
        // AND we override desk positions with hand-tuned CUSTOM_MAP_DESKS so each
        // agent sits in the right room on the AI-generated map.
        const world = this._resolveWorld();
        const customMapUri = this._resolveCustomOfficeMap();
        if (customMapUri) {
            world.desks = { ...world.desks, ...CUSTOM_MAP_DESKS };
        }
        this._panel.webview.postMessage({
            type: 'officeInit',
            agents,
            companyName: readCompanyName() || '1인 기업',
            companyDir: dir.replace(os.homedir(), '~'),
            assetsAvailable: Object.keys(characterUris).length > 0,
            world,
            customMapUri,
            debug: {
                userPath,
                bundledCount,
                userCount,
                missing,
                firstSpriteUri: firstUri,
                buildingsLoaded: world.buildings.filter(b => b.layer1Uri).length,
                decorationsLoaded: world.decorations.length,
                customMap: customMapUri ? 'OK' : 'none',
            }
        });
    }

    private _broadcastRoom(roomId: string) {
        const room = ROOMS.find(r => r.id === roomId);
        if (!room) return;
        const { floorUri, furnitureUri } = this._resolveRoomAssets(room);
        const animations = this._resolveAnimationUris(room);
        this._panel.webview.postMessage({
            type: 'roomChanged',
            roomId: room.id,
            name: room.name,
            emoji: room.emoji,
            floorUri,
            furnitureUri,
            animations,
            roomAgents: room.agents,
            roomHomePos: room.homePos,
        });
    }

    public dispose() {
        try { this._provider.unregisterCorporateBroadcastTarget(this._panel.webview); } catch { /* ignore */ }
        OfficePanel.current = undefined;
        try { this._provider.broadcastOfficeState(false); } catch { /* ignore */ }
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            try { d?.dispose(); } catch { /* ignore */ }
        }
    }

    private _renderHtml(): string {
        const csp = this._panel.webview.cspSource;
        return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob: https: vscode-resource: vscode-webview-resource:; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline'; font-src ${csp} data:;">
<title>🏢 가상 사무실</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'SF Pro Display',-apple-system,'Segoe UI',sans-serif}
:root{--accent:#00FF41;--accent2:#008F11;--accent-glow:rgba(0,255,65,.25);--bg:#070A0F;--bg2:#0B0E14;--surface:rgba(15,18,24,.85);--border:rgba(255,255,255,.08);--text:#E5E7EB;--text-dim:#9CA3AF}
html,body{width:100%;height:100%;background:var(--bg);color:var(--text);overflow:hidden}
body{display:flex;flex-direction:column}

/* ===== Top bar ===== */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(8,10,15,.92);border-bottom:1px solid var(--border);flex-shrink:0;backdrop-filter:blur(10px);z-index:10}
.topbar::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--accent) 50%,transparent);opacity:.4;animation:lineGlow 4s infinite alternate}
@keyframes lineGlow{0%{opacity:.2}100%{opacity:.6}}
.topbar h1{font-size:13px;font-weight:700;color:var(--text);letter-spacing:.3px}
.topbar h1 span{color:var(--accent);text-shadow:0 0 8px var(--accent-glow)}
.topbar .meta{font-family:'SF Mono',monospace;font-size:10px;color:var(--text-dim)}
.topbar .topbtn{background:var(--surface);border:1px solid var(--border);color:var(--text-dim);padding:5px 12px;border-radius:7px;cursor:pointer;font-size:10px;letter-spacing:.5px;text-transform:uppercase;font-family:'SF Mono',monospace;transition:all .25s}
.topbar .topbtn:hover{color:var(--accent);border-color:var(--accent);box-shadow:0 0 10px var(--accent-glow)}
.topbar .topbtn-mini{background:transparent;border:1px solid var(--border);color:var(--text-dim);width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:11px;display:inline-flex;align-items:center;justify-content:center;margin-left:4px;vertical-align:middle;transition:all .25s;padding:0}
.topbar .topbtn-mini:hover{color:var(--accent);border-color:var(--accent);box-shadow:0 0 8px var(--accent-glow)}

/* HUD stat chips — DAY / OUTPUT / IDLE-WORKING / TIME */
.hud{display:flex;align-items:center;gap:6px;font-family:'SF Mono',monospace;font-size:9.5px}
.hud .stat{display:flex;flex-direction:column;align-items:center;padding:3px 9px;background:rgba(0,255,65,.04);border:1px solid rgba(0,255,65,.18);border-radius:6px;min-width:54px;line-height:1.2}
.hud .stat .lbl{color:var(--text-dim);font-size:7.5px;letter-spacing:1.5px;text-transform:uppercase;opacity:.7}
.hud .stat .val{color:var(--accent);font-weight:700;font-size:11px;text-shadow:0 0 6px var(--accent-glow)}
.hud .stat.live .val::after{content:'';display:inline-block;width:5px;height:5px;background:#ef4444;border-radius:50%;margin-left:5px;animation:liveBlink 1.4s infinite;vertical-align:middle;box-shadow:0 0 4px #ef4444}
@keyframes liveBlink{0%,49%{opacity:1}50%,100%{opacity:.3}}
.hud .stat.warn{border-color:rgba(255,171,64,.3)}
.hud .stat.warn .val{color:#ffab40;text-shadow:0 0 6px rgba(255,171,64,.4)}

/* ===== Office Floor — unified office (single Office_Design_2.gif bg) =====
   Legacy TV-studio dual-layer rules (bg-stack, office-fg, office-anims) and
   the conflicting office-bg transform translate(-50%, -50%) shorthand have
   been removed — they were pulling the bg image off-screen by half its own
   size. */
.office-wrap{flex:1;display:flex;min-height:0}
.office-floor{flex:1;position:relative;overflow:hidden;border-right:1px solid var(--border);background:#070A0F}

/* === Unified office stage — ONE pre-built office bg fills the floor area ===
   stageInner has a fixed aspect-ratio matching the bg image (512×544).
   Agents are children of stageInner and use % coords that map directly to
   the bg image, so a character at (78,80)% lands inside the CEO office
   regardless of panel size. */
.office-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:0;background:#070A0F}
/* stageInner sized inline by fitStage() to maintain world aspect ratio (1400/700). */
.office-stage-inner{position:relative;--char-scale:1.5;overflow:hidden;border-radius:6px;box-shadow:0 0 0 1px rgba(0,255,65,.18),0 8px 32px rgba(0,0,0,.6)}

/* Garden grass — tiled LimeZu grass texture (base layer of world canvas).
   Tile size set inline by JS based on world scale so pixels stay crisp. */
.world-grass{position:absolute;inset:0;background-repeat:repeat;image-rendering:pixelated;image-rendering:crisp-edges;pointer-events:none;z-index:0}
/* Stone walkway paths between buildings — same tiled texture pattern */
.world-paths{position:absolute;inset:0;pointer-events:none;z-index:1}
.world-paths .path-strip{position:absolute;background-repeat:repeat;image-rendering:pixelated;image-rendering:crisp-edges;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)}
/* Buildings layer — pre-built scene PNGs/GIFs at fixed world pixel positions */
.world-buildings{position:absolute;inset:0;pointer-events:none;z-index:2}
.world-buildings img{position:absolute;image-rendering:pixelated;image-rendering:crisp-edges;display:block}
/* Decorations layer — single garden tiles (trees, benches, flowers) */
.world-decorations{position:absolute;inset:0;pointer-events:none;z-index:3}
.world-decorations img{position:absolute;image-rendering:pixelated;image-rendering:crisp-edges;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));display:block;transform:translate(-50%,-100%)}
.office-bg{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;pointer-events:none;display:block}
.office-zones{position:absolute;inset:0;pointer-events:none;z-index:2}
.office-zones .zone-label{position:absolute;font-family:'SF Mono',monospace;font-size:8px;letter-spacing:1px;color:var(--accent);text-transform:uppercase;text-shadow:0 0 6px rgba(0,255,65,.7),0 1px 2px rgba(0,0,0,.95);opacity:.55;transform:translate(-50%,-100%);white-space:nowrap;padding:1px 4px;border-radius:2px;background:rgba(0,8,4,.45)}
/* Hide legacy single-room overlay UI in unified-office mode. */
body.floorplan .conf-room,body.floorplan .location{display:none!important}
.office-vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.45) 100%);pointer-events:none;z-index:3}

/* Floating particles drifting up — feels alive */
.particles{position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden}
.particles span{position:absolute;width:2px;height:2px;border-radius:50%;background:rgba(0,255,65,.45);box-shadow:0 0 4px rgba(0,255,65,.7);animation:floatUp 14s linear infinite;opacity:0}
@keyframes floatUp{0%{transform:translateY(0);opacity:0}10%{opacity:.8}90%{opacity:.6}100%{transform:translateY(-100vh);opacity:0}}

/* Conference room — glass-walled boardroom with holographic projection */
.conf-room{position:absolute;left:50%;top:3%;transform:translateX(-50%);width:42%;min-width:340px;max-width:560px;height:20%;min-height:130px;
  background:
    linear-gradient(180deg,rgba(0,255,65,.07),rgba(0,143,17,.02)),
    radial-gradient(ellipse at 50% 100%,rgba(0,255,65,.12),transparent 60%);
  border:1px solid rgba(0,255,65,.5);border-radius:14px;
  box-shadow:
    inset 0 0 40px rgba(0,255,65,.1),
    inset 0 0 0 1px rgba(0,0,0,.5),
    0 8px 28px rgba(0,255,65,.18),
    0 0 60px rgba(0,255,65,.08);
  z-index:4;
  backdrop-filter:blur(2px)}
/* corner brackets — futuristic frame */
.conf-room::before{content:'';position:absolute;top:0;left:0;width:18px;height:18px;border-top:2px solid var(--accent);border-left:2px solid var(--accent);border-radius:14px 0 0 0;opacity:.7}
.conf-room::after{content:'';position:absolute;top:0;right:0;width:18px;height:18px;border-top:2px solid var(--accent);border-right:2px solid var(--accent);border-radius:0 14px 0 0;opacity:.7}
.conf-label{position:absolute;top:6px;left:50%;transform:translateX(-50%);font-family:'SF Mono',monospace;font-size:8px;letter-spacing:4px;color:var(--accent);opacity:.85;text-shadow:0 0 8px var(--accent-glow);z-index:5}
.conf-label::before{content:'◆ ';opacity:.6}
.conf-label::after{content:' ◆';opacity:.6}

/* glass holographic projection — shows brief during commands */
.whiteboard{position:absolute;top:20px;left:50%;transform:translateX(-50%);width:82%;max-width:420px;height:54px;
  background:linear-gradient(180deg,rgba(0,30,15,.92),rgba(0,15,8,.95));
  border:1px solid rgba(0,255,65,.3);border-radius:6px;
  display:flex;align-items:center;justify-content:center;
  font-family:'SF Mono',monospace;font-size:10.5px;color:var(--text-dim);text-align:center;padding:8px;line-height:1.4;overflow:hidden;
  box-shadow:inset 0 0 14px rgba(0,255,65,.06),0 0 0 1px rgba(0,0,0,.5)}
.whiteboard::before{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(0,255,65,.05) 2px 3px);pointer-events:none}
.whiteboard.active{border-color:var(--accent);background:linear-gradient(180deg,rgba(0,40,20,.95),rgba(0,20,10,.98));color:var(--text);box-shadow:inset 0 0 22px rgba(0,255,65,.18),0 0 24px var(--accent-glow);animation:wbPulse 2.4s ease-in-out infinite}
@keyframes wbPulse{0%,100%{box-shadow:inset 0 0 22px rgba(0,255,65,.18),0 0 24px var(--accent-glow)}50%{box-shadow:inset 0 0 28px rgba(0,255,65,.28),0 0 38px var(--accent-glow)}}
.whiteboard .wb-line{display:block;animation:wbType .4s ease-out backwards;position:relative;z-index:1}
@keyframes wbType{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}

/* conference table with holographic glow on top */
.conf-table{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);width:78%;height:26%;
  background:linear-gradient(180deg,#1a2028 0%,#0c1218 100%);
  border:1px solid rgba(0,255,65,.25);border-radius:50px;
  box-shadow:
    0 6px 14px rgba(0,0,0,.6),
    inset 0 1px 0 rgba(0,255,65,.15),
    inset 0 0 20px rgba(0,255,65,.06)}
.conf-table::before{content:'';position:absolute;left:8%;right:8%;top:30%;bottom:30%;background:radial-gradient(ellipse,rgba(0,255,65,.15),transparent 70%);border-radius:50%;animation:tablePulse 3s ease-in-out infinite}
@keyframes tablePulse{0%,100%{opacity:.5}50%{opacity:1}}

/* Workstations — proper desk with dual monitors, LED strip, PC tower */
.desk{position:absolute;width:108px;height:78px;transform:translate(-50%,-50%);z-index:3;pointer-events:none}
.desk .ds-top{position:absolute;left:0;right:0;top:24px;height:32px;
  background:linear-gradient(180deg,#1a2028 0%,#0c1218 100%);
  border:1px solid rgba(0,255,65,.2);border-radius:4px;
  box-shadow:0 4px 8px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.04)}
/* desk LED strip — glows in agent color */
.desk .ds-top::before{content:'';position:absolute;left:6px;right:6px;bottom:1px;height:1.5px;background:var(--ag-color,var(--accent));box-shadow:0 0 6px var(--ag-color,var(--accent));opacity:.8;border-radius:1px;animation:ledStripPulse 3s ease-in-out infinite}
@keyframes ledStripPulse{0%,100%{opacity:.5}50%{opacity:1}}
/* PC tower under desk */
.desk .ds-top::after{content:'';position:absolute;right:4px;bottom:-12px;width:9px;height:14px;background:linear-gradient(135deg,#1c2228,#0a0e14);border:1px solid rgba(255,255,255,.06);border-radius:1.5px;box-shadow:0 0 4px rgba(0,255,65,.2)}

/* Dual monitor frame */
.desk .ds-monitor{position:absolute;left:50%;top:0;transform:translateX(-50%);width:80px;height:30px;display:flex;gap:2px;justify-content:center}
.desk .ds-screen{flex:0 0 38px;height:26px;background:#000;border:1.2px solid #2a3038;border-radius:2px;
  box-shadow:0 0 10px rgba(0,255,65,.18),inset 0 0 0 1px rgba(0,0,0,.5);
  overflow:hidden;position:relative}
/* monitor stand */
.desk .ds-monitor::after{content:'';position:absolute;left:50%;bottom:-4px;transform:translateX(-50%);width:14px;height:4px;background:#1a1f26;border-radius:0 0 4px 4px;box-shadow:0 1px 2px rgba(0,0,0,.6)}
/* scanline overlay on each screen */
.desk .ds-screen::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 1px,rgba(0,0,0,.25) 1px 2px);pointer-events:none;z-index:3}
.desk .ds-screen::before{content:'';position:absolute;inset:0;z-index:1}

/* Per-agent screen content */
/* CEO: command graph with sweeping radar arm */
.desk[data-agent="ceo"] .ds-screen::before{background:radial-gradient(circle at 50% 50%,rgba(0,255,65,.4) 0%,rgba(0,255,65,0) 1px,rgba(0,255,65,.1) 2px,rgba(0,255,65,0) 3px,rgba(0,255,65,.1) 6px,rgba(0,255,65,0) 7px,rgba(0,255,65,.08) 12px,rgba(0,255,65,0) 13px),conic-gradient(from 0deg,rgba(0,255,65,.5),transparent 70%);animation:radarSweep 4s linear infinite}
@keyframes radarSweep{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* Developer: scrolling code lines */
.desk[data-agent="developer"] .ds-screen::before{background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(34,211,238,.7) 3px 4px,transparent 4px 7px,rgba(34,211,238,.4) 7px 8px,transparent 8px 12px,rgba(34,211,238,.55) 12px 13px,transparent 13px 16px,rgba(34,211,238,.3) 16px 17px,transparent 17px 22px);background-size:100% 22px;animation:codeScroll 3s linear infinite}
@keyframes codeScroll{from{background-position:0 0}to{background-position:0 22px}}

/* Designer: rotating color swatches */
.desk[data-agent="designer"] .ds-screen::before{background:conic-gradient(from 0deg,#FF0033 0deg 60deg,#FBBF24 60deg 120deg,#22D3EE 120deg 180deg,#A78BFA 180deg 240deg,#34D399 240deg 300deg,#E1306C 300deg 360deg);filter:saturate(.85) brightness(.7);animation:colorSpin 8s linear infinite;border-radius:50%;margin:6px}
@keyframes colorSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* YouTube: red bars rising/falling like audio meter */
.desk[data-agent="youtube"] .ds-screen::before{background:linear-gradient(90deg,
  rgba(255,0,51,.7) 0%,rgba(255,0,51,.7) 8%,transparent 8% 12%,
  rgba(255,0,51,.5) 12% 20%,transparent 20% 24%,
  rgba(255,0,51,.8) 24% 32%,transparent 32% 36%,
  rgba(255,0,51,.4) 36% 44%,transparent 44% 48%,
  rgba(255,0,51,.6) 48% 56%,transparent 56% 60%,
  rgba(255,0,51,.7) 60% 68%,transparent 68% 72%,
  rgba(255,0,51,.5) 72% 80%,transparent 80% 84%,
  rgba(255,0,51,.6) 84% 92%,transparent 92% 100%);background-size:100% 100%;animation:audioBars .6s ease-in-out infinite alternate;mask-image:linear-gradient(0deg,#000 0%,#000 100%)}
@keyframes audioBars{from{filter:hue-rotate(0deg)}to{filter:hue-rotate(20deg) brightness(1.2)}}

/* Instagram: pink heart pulse + grid */
.desk[data-agent="instagram"] .ds-screen::before{background:radial-gradient(circle at 50% 55%,rgba(225,48,108,.85) 0%,rgba(225,48,108,.5) 20%,transparent 35%),repeating-linear-gradient(0deg,rgba(247,119,55,.15) 0 4px,transparent 4px 8px),repeating-linear-gradient(90deg,rgba(247,119,55,.15) 0 4px,transparent 4px 8px);animation:igPulse 1.6s ease-in-out infinite}
@keyframes igPulse{0%,100%{transform:scale(.95);opacity:.7}50%{transform:scale(1.05);opacity:1}}

/* Business: bar chart growing */
.desk[data-agent="business"] .ds-screen::before{background:linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 30%,transparent 30%) 0 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 50%,transparent 50%) 16% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 70%,transparent 70%) 32% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 45%,transparent 45%) 48% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 85%,transparent 85%) 64% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 60%,transparent 60%) 80% 100%/12% 100% no-repeat;animation:barsRise 2.4s ease-in-out infinite alternate}
@keyframes barsRise{from{filter:brightness(.7)}to{filter:brightness(1.2)}}

/* Secretary: scrolling event list */
.desk[data-agent="secretary"] .ds-screen::before{background:repeating-linear-gradient(0deg,rgba(52,211,153,.55) 0 2px,transparent 2px 4px,rgba(52,211,153,.3) 4px 5px,transparent 5px 8px);background-size:100% 16px;animation:listScroll 4s linear infinite}
@keyframes listScroll{from{background-position:0 0}to{background-position:0 16px}}

/* second screen — slightly dimmer secondary feed */
.desk .ds-screen.s2{opacity:.65}

.desk .ds-chair{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:30px;height:18px;
  background:linear-gradient(180deg,#1a2030,#0c1220);
  border:1px solid rgba(0,255,65,.18);border-radius:5px 5px 9px 9px;
  box-shadow:0 2px 4px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.04)}
.desk[data-side="bottom"] .ds-chair{top:0;bottom:auto;border-radius:9px 9px 5px 5px}
.desk[data-side="bottom"] .ds-monitor{top:auto;bottom:0}
.desk[data-side="bottom"] .ds-top{top:auto;bottom:24px}

.desk-label{position:absolute;left:50%;bottom:-12px;transform:translateX(-50%);font-family:'SF Mono',monospace;font-size:7px;letter-spacing:1.5px;color:var(--ag-color,var(--text-dim));opacity:.6;white-space:nowrap;text-transform:uppercase;text-shadow:0 0 4px var(--ag-color-glow,transparent)}
.desk[data-side="bottom"] .desk-label{bottom:auto;top:-12px}

/* Decor — emoji icons with subtle float */
.decor{position:absolute;pointer-events:none;z-index:3;font-size:24px;filter:drop-shadow(0 3px 5px rgba(0,0,0,.7));animation:decorFloat 5s ease-in-out infinite}
.decor:nth-of-type(odd){animation-delay:-2s}
@keyframes decorFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}

/* ===== Locations — Smallville routine destinations (JS positions to bg-image %) ===== */
.location{position:absolute;transform:translate(-50%,-50%);z-index:5;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:2px;background:rgba(0,0,0,.65);border:1px solid rgba(0,255,65,.4);border-radius:8px;padding:4px 8px;backdrop-filter:blur(2px)}
.location .loc-icon{font-size:18px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.8))}
.location .loc-label{font-family:'SF Mono',monospace;font-size:7px;letter-spacing:1.5px;color:var(--accent);opacity:.85;white-space:nowrap;text-transform:uppercase;text-shadow:0 0 4px var(--accent-glow)}
.location.active{animation:locPulse 1.5s ease-in-out infinite;border-color:var(--accent);box-shadow:0 0 14px var(--accent-glow)}
@keyframes locPulse{0%,100%{box-shadow:0 0 14px var(--accent-glow)}50%{box-shadow:0 0 22px var(--accent-glow)}}
.loc-brain{border-color:rgba(167,139,250,.6)}
.loc-brain .loc-label{color:#A78BFA;text-shadow:0 0 4px rgba(167,139,250,.5)}
.loc-brain.active{border-color:#A78BFA;box-shadow:0 0 16px rgba(167,139,250,.6)}

/* ===== Status icon above each agent (mood/state) ===== */
.ag-status{position:absolute;top:-22px;left:50%;transform:translateX(-50%);font-size:11px;background:rgba(8,10,15,.92);border:1px solid var(--ag-color,var(--accent));border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;line-height:1;z-index:8;box-shadow:0 0 6px var(--ag-color-glow,var(--accent-glow));transition:all .3s;animation:statusPop .35s cubic-bezier(.16,1,.3,1)}
@keyframes statusPop{from{transform:translateX(-50%) scale(0)}to{transform:translateX(-50%) scale(1)}}
.ag-status.fade{opacity:0;transform:translateX(-50%) scale(.8)}

/* Thought bubble (small dotted bubble for inner monologue) */
.thought{position:absolute;left:50%;bottom:calc(100% + 22px);transform:translateX(-50%);background:rgba(8,10,15,.94);border:1px dashed var(--ag-color,var(--accent));border-radius:14px;padding:5px 11px;font-size:9.5px;font-style:italic;color:var(--text-dim);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;font-family:'SF Mono',monospace;z-index:19;box-shadow:0 4px 12px rgba(0,0,0,.6);animation:thoughtIn .4s cubic-bezier(.16,1,.3,1)}
.thought::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);width:5px;height:5px;border-radius:50%;background:rgba(8,10,15,.94);border:1px dashed var(--ag-color,var(--accent));margin-top:2px}
.thought::before{content:'';position:absolute;left:calc(50% - 9px);top:calc(100% + 7px);width:3px;height:3px;border-radius:50%;background:rgba(8,10,15,.94);border:1px dashed var(--ag-color,var(--accent))}
@keyframes thoughtIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* ===== Agent profile modal — centered overlay with backdrop, on top of everything ===== */
.agent-modal-backdrop{position:fixed;inset:0;background:rgba(0,5,10,.65);backdrop-filter:blur(3px);z-index:200;display:flex;align-items:center;justify-content:center;animation:amdBdIn .25s ease-out}
.agent-modal-backdrop[hidden]{display:none}
@keyframes amdBdIn{from{opacity:0}to{opacity:1}}
.agent-modal{position:relative;width:min(420px,92vw);max-height:88vh;background:linear-gradient(180deg,rgba(10,14,22,.98),rgba(8,10,15,.99));border:1px solid rgba(0,255,65,.5);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:11px;box-shadow:0 20px 60px rgba(0,0,0,.85),0 0 40px var(--accent-glow);overflow-y:auto;animation:amdIn .35s cubic-bezier(.16,1,.3,1)}
@keyframes amdIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
.agent-modal::-webkit-scrollbar{width:5px}
.agent-modal::-webkit-scrollbar-thumb{background:var(--accent);opacity:.4;border-radius:2px}
.amd-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:1px solid rgba(0,255,65,.18)}
.amd-emoji{font-size:24px;width:38px;height:38px;display:flex;align-items:center;justify-content:center;background:rgba(0,255,65,.06);border:1px solid rgba(0,255,65,.3);border-radius:8px}
.amd-title{flex:1;min-width:0}
.amd-name{font-size:13px;font-weight:700;color:var(--accent);letter-spacing:.3px}
.amd-role{font-size:9.5px;color:var(--text-dim);font-family:'SF Mono',monospace;letter-spacing:1px;text-transform:uppercase;margin-top:2px}
.amd-close{background:transparent;border:1px solid var(--border);color:var(--text-dim);width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:12px;line-height:1;transition:all .2s}
.amd-close:hover{color:#ef4444;border-color:#ef4444;box-shadow:0 0 6px rgba(239,68,68,.4)}
.amd-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.amd-stat{background:rgba(0,255,65,.04);border:1px solid rgba(0,255,65,.18);border-radius:6px;padding:6px 8px;text-align:center}
.amd-stat-lbl{font-family:'SF Mono',monospace;font-size:7px;color:var(--text-dim);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px}
.amd-stat-val{font-size:13px;font-weight:700;color:var(--accent);text-shadow:0 0 6px var(--accent-glow);font-family:'SF Mono',monospace}
.amd-section{display:flex;flex-direction:column;gap:5px;flex:1;min-height:80px}
.amd-section-head{font-family:'SF Mono',monospace;font-size:9px;letter-spacing:1.5px;color:var(--text-dim);text-transform:uppercase;opacity:.8}
.amd-content{background:rgba(0,255,65,.025);border:1px solid rgba(0,255,65,.12);border-radius:6px;padding:8px 10px;font-size:10.5px;color:var(--text);font-family:'SF Mono',monospace;line-height:1.55;max-height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;margin:0}
.amd-content::-webkit-scrollbar{width:4px}
.amd-content::-webkit-scrollbar-thumb{background:var(--accent);opacity:.4;border-radius:2px}
.amd-sessions{display:flex;flex-direction:column;gap:3px;font-size:10px;font-family:'SF Mono',monospace;color:var(--text-dim)}
.amd-sessions .amd-sess{padding:3px 8px;background:rgba(0,255,65,.03);border:1px solid rgba(0,255,65,.1);border-radius:4px}
.amd-foot{padding-top:8px;border-top:1px solid rgba(0,255,65,.18);display:flex;gap:6px}
.amd-btn{flex:1;background:rgba(0,255,65,.06);border:1px solid rgba(0,255,65,.3);color:var(--accent);padding:7px 10px;border-radius:6px;cursor:pointer;font-size:10px;font-family:'SF Mono',monospace;letter-spacing:.5px;transition:all .2s}
.amd-btn:hover{background:rgba(0,255,65,.12);box-shadow:0 0 10px var(--accent-glow)}
.amd-btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#000;border-color:transparent;font-weight:700}
.amd-btn.primary:hover{filter:brightness(1.15);box-shadow:0 4px 14px var(--accent-glow)}

/* Per-agent settings form fields */
.amd-form{display:flex;flex-direction:column;gap:8px}
.amd-field{display:flex;flex-direction:column;gap:3px}
.amd-field-lbl{font-family:'SF Mono',monospace;font-size:8.5px;letter-spacing:1.2px;color:var(--text-dim);text-transform:uppercase;opacity:.85}
.amd-field-help{font-size:9px;color:var(--text-dim);opacity:.6;margin-top:1px;font-style:italic}
.amd-input{background:rgba(0,255,65,.04);border:1px solid rgba(0,255,65,.18);border-radius:5px;padding:7px 9px;font-size:11px;color:var(--text);font-family:'SF Mono',monospace;outline:none;transition:all .2s}
.amd-input:focus{border-color:var(--accent);box-shadow:0 0 8px var(--accent-glow);background:rgba(0,255,65,.08)}
textarea.amd-input{resize:vertical;min-height:50px;line-height:1.45}
.amd-save-status{font-size:9.5px;font-family:'SF Mono',monospace;letter-spacing:.5px;text-align:center;padding:4px;border-radius:4px;opacity:0;transition:opacity .3s}
.amd-save-status.show{opacity:1}
.amd-save-status.success{color:var(--accent);background:rgba(0,255,65,.08)}
.amd-save-status.error{color:#ef4444;background:rgba(239,68,68,.08)}

/* ===== Corporate Gate — cinematic centered access modal ===== */
.cg-backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,rgba(0,12,6,.55) 0%,rgba(0,0,0,.9) 80%);backdrop-filter:blur(10px) saturate(1.2);-webkit-backdrop-filter:blur(10px) saturate(1.2);animation:cgBdIn .35s ease-out}
.cg-backdrop[hidden]{display:none}
@keyframes cgBdIn{from{opacity:0;backdrop-filter:blur(0)}to{opacity:1;backdrop-filter:blur(10px)}}
.cg-backdrop::before{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(0,255,65,.025) 0px,rgba(0,255,65,.025) 1px,transparent 1px,transparent 3px);pointer-events:none;animation:cgScan 8s linear infinite;mix-blend-mode:screen}
@keyframes cgScan{from{background-position:0 0}to{background-position:0 100px}}

.cg-modal{position:relative;width:min(380px,90vw);background:linear-gradient(180deg,rgba(6,12,8,.98),rgba(2,6,3,.99));border:1px solid rgba(0,255,65,.55);border-radius:14px;padding:28px 26px 22px;box-shadow:0 0 0 1px rgba(0,255,65,.08) inset,0 30px 80px rgba(0,0,0,.85),0 0 60px rgba(0,255,65,.25),0 0 120px rgba(0,255,65,.12);animation:cgIn .55s cubic-bezier(.16,1,.3,1);transform-origin:center}
.cg-modal.shake{animation:cgShake .45s cubic-bezier(.36,.07,.19,.97);border-color:rgba(239,68,68,.7);box-shadow:0 0 0 1px rgba(239,68,68,.18) inset,0 30px 80px rgba(0,0,0,.85),0 0 60px rgba(239,68,68,.4),0 0 120px rgba(239,68,68,.18)}
@keyframes cgIn{0%{opacity:0;transform:translateY(20px) scale(.92);filter:blur(6px)}60%{opacity:1;transform:translateY(-2px) scale(1.01);filter:blur(0)}100%{opacity:1;transform:translateY(0) scale(1);filter:blur(0)}}
@keyframes cgShake{0%,100%{transform:translateX(0)}10%{transform:translateX(-8px)}20%{transform:translateX(7px)}30%{transform:translateX(-6px)}40%{transform:translateX(5px)}50%{transform:translateX(-4px)}60%{transform:translateX(3px)}70%{transform:translateX(-2px)}80%{transform:translateX(1px)}}

/* corner brackets */
.cg-modal::before,.cg-modal::after,.cg-corner{position:absolute;width:18px;height:18px;border:2px solid var(--accent);pointer-events:none;filter:drop-shadow(0 0 4px var(--accent-glow))}
.cg-modal::before{content:'';top:-1px;left:-1px;border-right:none;border-bottom:none;border-top-left-radius:14px}
.cg-modal::after{content:'';top:-1px;right:-1px;border-left:none;border-bottom:none;border-top-right-radius:14px}
.cg-corner.bl{bottom:-1px;left:-1px;border-right:none;border-top:none;border-bottom-left-radius:14px}
.cg-corner.br{bottom:-1px;right:-1px;border-left:none;border-top:none;border-bottom-right-radius:14px}

.cg-lock-wrap{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:14px}
.cg-lock{font-size:42px;line-height:1;filter:drop-shadow(0 0 12px var(--accent-glow));animation:cgLockPulse 2.4s ease-in-out infinite}
@keyframes cgLockPulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 12px var(--accent-glow))}50%{transform:scale(1.06);filter:drop-shadow(0 0 20px var(--accent-glow)) drop-shadow(0 0 32px var(--accent-glow))}}
.cg-tag{font-family:'SF Mono','JetBrains Mono',monospace;font-size:9px;letter-spacing:3px;color:var(--accent);opacity:.7;text-transform:uppercase;padding:2px 8px;border:1px solid rgba(0,255,65,.3);border-radius:3px;background:rgba(0,255,65,.05)}

.cg-title{text-align:center;font-size:15px;font-weight:700;letter-spacing:1.5px;color:#F8FAFC;text-shadow:0 0 8px rgba(0,255,65,.5);margin-bottom:4px;font-family:'SF Mono',monospace}
.cg-sub{text-align:center;font-size:11px;color:var(--text-dim);line-height:1.55;margin-bottom:18px;font-family:'SF Mono',monospace;letter-spacing:.3px}

.cg-input-wrap{position:relative;margin-bottom:8px}
.cg-input{width:100%;background:rgba(0,16,4,.7);border:1px solid rgba(0,255,65,.35);border-radius:8px;padding:14px 16px;font-size:18px;color:var(--accent);font-family:'SF Mono','JetBrains Mono',monospace;letter-spacing:8px;text-align:center;outline:none;transition:all .25s;text-shadow:0 0 8px var(--accent-glow);box-sizing:border-box;caret-color:var(--accent)}
.cg-input::placeholder{color:rgba(0,255,65,.25);letter-spacing:4px;font-size:13px}
.cg-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,255,65,.12),0 0 18px rgba(0,255,65,.35);background:rgba(0,28,8,.85)}

.cg-err{min-height:16px;text-align:center;font-size:10px;color:#ef4444;font-family:'SF Mono',monospace;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:14px;opacity:0;transition:opacity .2s;text-shadow:0 0 6px rgba(239,68,68,.5)}
.cg-err.show{opacity:1}

.cg-actions{display:flex;gap:8px}
.cg-btn{flex:1;padding:10px 14px;border-radius:7px;font-family:'SF Mono',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;transition:all .2s;font-weight:700}
.cg-btn.cancel{background:transparent;border:1px solid rgba(255,255,255,.12);color:var(--text-dim)}
.cg-btn.cancel:hover{border-color:rgba(255,255,255,.25);color:#fff;background:rgba(255,255,255,.04)}
.cg-btn.ok{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#000;box-shadow:0 4px 18px rgba(0,255,65,.35)}
.cg-btn.ok:hover{filter:brightness(1.15);box-shadow:0 6px 24px rgba(0,255,65,.55),0 0 20px rgba(0,255,65,.4);transform:translateY(-1px)}
.cg-btn.ok:active{transform:translateY(0)}

/* Agent piece — inline-SVG character + nameplate. Furniture is CSS-drawn behind. */
.agent{position:absolute;width:60px;display:flex;flex-direction:column;align-items:center;gap:3px;transition:left .9s cubic-bezier(.16,1,.3,1),top .9s cubic-bezier(.16,1,.3,1);z-index:6;filter:drop-shadow(0 4px 6px rgba(0,0,0,.65));transform:scale(var(--char-scale,1));transform-origin:50% 96px}
.agent .ag-led{position:absolute;top:-4px;right:6px;width:5px;height:5px;border-radius:50%;background:var(--text-dim);opacity:.4;transition:all .3s;z-index:7}
.agent.thinking .ag-led{background:#ffab40;animation:ledBlink 1s infinite;box-shadow:0 0 6px #ffab40;opacity:1}
.agent.working .ag-led{background:var(--ag-color,var(--accent));animation:ledBlink .7s infinite;box-shadow:0 0 8px var(--ag-color,var(--accent));opacity:1}
.agent.done .ag-led{background:#00cc77;box-shadow:0 0 6px #00cc77;opacity:1}
@keyframes ledBlink{0%,100%{opacity:1}50%{opacity:.4}}

/* Sprite character — LimeZu Premade_Character_48x48 atlas (2688×1968).
   CRITICAL: each character cell is 48 wide × 96 tall (TILE × CHAR_HEIGHT, where CHAR_HEIGHT = TILE*2).
   Rendering this as 48×48 (the bug we hit before) shows only the head/hair.
   Idle frame: row 1, col 0 → background-position: 0 -96px
   Walking row: row 2 (y=-192), 6 frames per direction (down 0–5, left 6–11, right 12–17, up 18–23) */
.character{width:48px;height:96px;position:relative;overflow:hidden;image-rendering:pixelated;cursor:default;background-repeat:no-repeat;background-position:0 -96px;background-size:auto;filter:drop-shadow(0 6px 8px rgba(0,0,0,.65));animation:charBob 2.4s ease-in-out infinite;transform:scale(0.8);transform-origin:center bottom}
@keyframes charBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}

/* State glow under character */
.character::before{content:'';position:absolute;left:50%;bottom:-4px;transform:translateX(-50%);width:36px;height:6px;border-radius:50%;background:radial-gradient(ellipse,var(--ag-color-glow,rgba(0,0,0,.4)) 0%,transparent 70%);opacity:0;transition:opacity .3s;pointer-events:none;z-index:-1}
.agent.working .character::before,.agent.thinking .character::before{opacity:1}

.ag-plate{font-family:'SF Mono','JetBrains Mono',monospace;font-size:8.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text-bright);padding:2px 7px;background:rgba(0,0,0,.85);border:1px solid var(--ag-color,var(--border));border-radius:5px;text-shadow:0 0 4px var(--ag-color-glow,transparent);white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.agent.idle .ag-plate{opacity:.7}
.agent.working .ag-plate{color:var(--ag-color,var(--accent));box-shadow:0 0 10px var(--ag-color-glow,var(--accent-glow)),0 2px 6px rgba(0,0,0,.5)}

/* Speech bubble above character (task toast / chat) */
.bubble{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);background:rgba(8,10,15,.96);border:1px solid var(--ag-color,var(--accent));border-radius:8px;padding:5px 10px;font-size:10px;color:var(--text-bright);white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;font-family:'SF Mono',monospace;z-index:20;box-shadow:0 4px 14px rgba(0,0,0,.7),0 0 14px var(--ag-color-glow,var(--accent-glow));animation:bubbleIn .35s cubic-bezier(.16,1,.3,1)}
.bubble::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--ag-color,var(--accent))}
@keyframes bubbleIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* SVG dispatch beams */
.beams{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;opacity:0;transition:opacity .3s}
body.dispatching .beams{opacity:1}
.beams .beam{stroke-dasharray:6 8;fill:none;animation:beamFlow 1.4s linear}
@keyframes beamFlow{0%{stroke-dashoffset:80;opacity:0}20%{opacity:1}100%{stroke-dashoffset:0;opacity:.7}}

/* ===== Side panel (activity log + report) — collapsed by default to maximize map ===== */
.side{width:260px;flex-shrink:0;background:var(--bg2);border-left:1px solid var(--border);display:flex;flex-direction:column;min-height:0;transition:width .25s ease,border-left-width .25s ease}
.side.collapsed{width:0;border-left-width:0;overflow:hidden}
.side-tabs{display:flex;border-bottom:1px solid var(--border);flex-shrink:0}
.side-tab{flex:1;padding:7px;background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-family:'SF Mono',monospace;font-size:9px;letter-spacing:.8px;text-transform:uppercase;border-bottom:2px solid transparent;transition:all .2s}
.side-tab:hover{color:var(--text)}
.side-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.side-pane{flex:1;overflow-y:auto;padding:10px;display:none}
.side-pane.active{display:block}
.side-pane::-webkit-scrollbar{width:4px}
.side-pane::-webkit-scrollbar-thumb{background:var(--accent);opacity:.5;border-radius:2px}

/* Activity log entries — tighter packing */
.log-entry{display:flex;gap:6px;padding:4px 6px;margin-bottom:3px;background:var(--surface);border-left:2px solid var(--ag-color,var(--accent));border-radius:0 5px 5px 0;font-size:10px;animation:logIn .3s ease-out}
@keyframes logIn{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}
.log-time{font-family:'SF Mono',monospace;font-size:8px;color:var(--text-dim);flex-shrink:0;width:34px}
.log-emoji{flex-shrink:0;font-size:11px}
.log-text{color:var(--text);font-size:9.5px;line-height:1.4}
.log-text strong{color:var(--ag-color,var(--accent))}

/* Output stream cards (per agent) */
.out-card{background:var(--surface);border:1px solid var(--ag-color,var(--border));border-left:3px solid var(--ag-color,var(--accent));border-radius:6px;padding:10px 12px;margin-bottom:10px;animation:logIn .35s ease-out}
.out-head{font-family:'SF Mono',monospace;font-size:10px;letter-spacing:.5px;font-weight:700;color:var(--ag-color,var(--accent));margin-bottom:6px;display:flex;align-items:center;gap:6px}
.out-head .oh-task{color:var(--text-dim);font-weight:400;font-size:9px}
.out-body{font-size:11px;color:var(--text);line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto}
.out-body::-webkit-scrollbar{width:4px}.out-body::-webkit-scrollbar-thumb{background:var(--ag-color,var(--accent));opacity:.4}
.report-block{background:linear-gradient(135deg,rgba(0,255,65,.05),rgba(0,143,17,.02));border:1px solid rgba(0,255,65,.3);border-radius:8px;padding:14px;margin-top:10px;color:var(--text);font-size:11.5px;line-height:1.65;white-space:pre-wrap;animation:logIn .4s ease-out;box-shadow:0 0 14px rgba(0,255,65,.08)}
.report-block .rb-head{font-family:'SF Mono',monospace;font-size:10px;letter-spacing:1.5px;color:var(--accent);margin-bottom:8px;text-transform:uppercase}

/* ===== Bottom command bar ===== */
.cmdbar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(8,10,15,.96);border-top:1px solid var(--border);flex-shrink:0;z-index:10}
.cmdbar input{flex:1;background:rgba(0,10,2,.7);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-family:inherit;font-size:13px;outline:none;transition:all .2s}
.cmdbar input:focus{border-color:var(--accent);box-shadow:0 0 14px var(--accent-glow)}
.cmdbar button{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;transition:all .2s}
.cmdbar button:hover{transform:translateY(-1px);box-shadow:0 4px 14px var(--accent-glow)}
.cmdbar button:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}

/* ===== Empty state ===== */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim);font-size:12px;text-align:center;padding:40px 20px;line-height:1.7}
.empty .empty-icon{font-size:48px;margin-bottom:12px;opacity:.6}
.empty code{background:var(--surface);border:1px solid var(--border);padding:2px 6px;border-radius:4px;color:var(--accent);font-family:'SF Mono',monospace}
</style>
</head>
<body>

<div class="topbar">
  <h1>🏢 <span id="topCompany">Loading...</span> · <span style="color:var(--text-dim);font-weight:400">Virtual Office</span> <button class="topbtn-mini" id="pickFolderBtn" title="회사 폴더 변경">⚙️</button></h1>
  <div class="hud">
    <div class="stat live"><div class="lbl">DAY</div><div class="val" id="hudDay">1</div></div>
    <div class="stat"><div class="lbl">TIME</div><div class="val" id="hudTime">09:00</div></div>
    <div class="stat"><div class="lbl">OUTPUT</div><div class="val" id="hudOutput">0</div></div>
    <div class="stat" id="hudWorkingStat"><div class="lbl">WORKING</div><div class="val" id="hudWorking">0/7</div></div>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <select class="topbtn" id="roomSelect" title="룸 전환" style="appearance:none;-webkit-appearance:none;padding-right:24px;background-image:linear-gradient(45deg,transparent 50%,var(--text-dim) 50%),linear-gradient(135deg,var(--text-dim) 50%,transparent 50%);background-position:calc(100% - 14px) 50%,calc(100% - 9px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat"></select>
    <button class="topbtn" id="autoBtn">🚶 자율 ON</button>
    <button class="topbtn" id="chatterBtn" title="에이전트들끼리 즉석 대화 한 라운드">💬 자율 대화</button>
    <button class="topbtn" id="toggleSideBtn" title="활동 로그 패널 토글">📋 로그</button>
    <button class="topbtn" id="folderBtn">📁 폴더 열기</button>
  </div>
</div>

<div class="office-wrap">
  <div class="office-floor" id="floor">

    <!-- Connected campus world (Phase B-1) — Office + Cafe buildings on a
         garden grass canvas. Single coord space (% of stageInner) so agents
         walk freely between zones. -->
    <div class="office-stage" id="officeStage">
      <div class="office-stage-inner" id="stageInner">
        <div class="world-grass" id="worldGrass"></div>
        <div class="world-paths" id="worldPaths"></div>
        <div class="world-buildings" id="worldBuildings"></div>
        <div class="world-decorations" id="worldDecor"></div>
        <div class="office-zones" id="officeZones"></div>
        <!-- agents inserted here by JS — coords resolve % of stageInner -->
      </div>
    </div>

    <!-- Floating particles for ambient feel -->
    <div class="particles" id="particles"></div>

    <!-- Conference area (CEO + whiteboard at top of studio, where wall monitors are) -->
    <div class="conf-room">
      <div class="conf-label">CONFERENCE</div>
      <div class="whiteboard" id="whiteboard">대기 중 — 명령을 내리면 팀이 움직입니다</div>
    </div>

    <!-- Smallville locations — emoji markers (no heavy CSS furniture, image bg provides studio look) -->
    <div class="location loc-coffee"     data-loc="coffee"><div class="loc-icon">☕</div><div class="loc-label">COFFEE</div></div>
    <div class="location loc-whiteboard" data-loc="whiteboard"><div class="loc-icon">📊</div><div class="loc-label">BOARD</div></div>
    <div class="location loc-lounge"     data-loc="lounge"><div class="loc-icon">🛋️</div><div class="loc-label">LOUNGE</div></div>
    <div class="location loc-server"     data-loc="server"><div class="loc-icon">🖥️</div><div class="loc-label">SERVERS</div></div>
    <div class="location loc-brain"      data-loc="brain"><div class="loc-icon">🧠</div><div class="loc-label">SECOND BRAIN</div></div>

    <div class="office-vignette"></div>
    <svg class="beams" id="beams" preserveAspectRatio="none"></svg>
    <!-- agents injected by JS -->

  </div>

  <!-- Agent profile modal — centered overlay above everything -->
  <div class="agent-modal-backdrop" id="agentModalBackdrop" hidden>
    <div class="agent-modal" id="agentModal" role="dialog" aria-modal="true">
      <div class="amd-head">
        <span class="amd-emoji" id="amdEmoji"></span>
        <div class="amd-title"><div class="amd-name" id="amdName">—</div><div class="amd-role" id="amdRole">—</div></div>
        <button class="amd-close" id="amdClose">✕</button>
      </div>
      <div class="amd-stats">
        <div class="amd-stat"><div class="amd-stat-lbl">SESSIONS</div><div class="amd-stat-val" id="amdSessions">0</div></div>
        <div class="amd-stat"><div class="amd-stat-lbl">STATE</div><div class="amd-stat-val" id="amdState">IDLE</div></div>
        <div class="amd-stat"><div class="amd-stat-lbl">SPECIALTY</div><div class="amd-stat-val" id="amdSpecialty" style="font-size:9px">—</div></div>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">⚙️ 외부 연결 / API</div>
        <div class="amd-form" id="amdConfigForm"><span style="font-size:10px;color:var(--text-dim)">이 에이전트는 별도 설정이 없습니다.</span></div>
        <div class="amd-save-status" id="amdSaveStatus"></div>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">🧠 메모리 (memory.md)</div>
        <pre class="amd-content" id="amdMemory">불러오는 중…</pre>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">📜 의사결정 로그 (decisions.md)</div>
        <pre class="amd-content" id="amdDecisions">불러오는 중…</pre>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">📁 최근 세션</div>
        <div id="amdSessionList" class="amd-sessions">—</div>
      </div>
      <div class="amd-foot">
        <button class="amd-btn primary" id="amdSaveConfig">💾 저장</button>
        <button class="amd-btn" id="amdOpenFolder">📁 폴더</button>
      </div>
    </div>
  </div>
  <div class="side">
    <div class="side-tabs">
      <button class="side-tab active" data-pane="logPane">활동 로그</button>
      <button class="side-tab" data-pane="outPane">산출물</button>
      <button class="side-tab" data-pane="convPane">📜 대화록</button>
    </div>
    <div class="side-pane active" id="logPane"></div>
    <div class="side-pane" id="outPane"><div class="empty"><span class="empty-icon">📭</span>아직 산출물이 없어요.<br>아래 명령창에 일을 던져주세요.</div></div>
    <div class="side-pane" id="convPane"><div style="padding:10px;font-family:'SF Mono',monospace;font-size:9.5px;color:var(--text);white-space:pre-wrap;line-height:1.5"><div id="convDate" style="font-size:8px;color:var(--text-dim);margin-bottom:8px;letter-spacing:1px">오늘 대화록 로딩 중…</div><div id="convBody"></div><div style="margin-top:14px;text-align:center"><button class="topbtn" id="reloadConvBtn">🔄 새로고침</button></div></div></div>
  </div>
</div>

<!-- 명령창은 사이드바에 통합됨. 사무실 패널은 시각화 전용. -->
<div class="cmdbar" style="display:none">
  <input id="cmdInput" type="hidden" />
  <button id="cmdSend" style="display:none">전송 ↑</button>
</div>

<script>
const vscode = acquireVsCodeApi();
const floor = document.getElementById('floor');
const beams = document.getElementById('beams');
const whiteboard = document.getElementById('whiteboard');
const cmdInput = document.getElementById('cmdInput');
const cmdSend = document.getElementById('cmdSend');
const logPane = document.getElementById('logPane');
const outPane = document.getElementById('outPane');
const topCompany = document.getElementById('topCompany');
const topMeta = document.getElementById('topMeta');
const folderBtn = document.getElementById('folderBtn');

let agents = [];
let agentMap = {};
let deskEls = {};   /* alias: agent elements */
let outCardEls = {};
let currentTasks = [];
/* Home desk positions are % of the WORLD canvas (1400×700 campus).
   Replaced by world.desks at officeInit time; placeholder below covers
   the brief moment before the message arrives. Office is at world
   x=540..1052, y=90..634, so each agent's office-local % maps to world. */
let HOME_POS = {
  youtube:   { x: 49, y: 41 },
  instagram: { x: 56, y: 41 },
  designer:  { x: 63, y: 41 },
  business:  { x: 69, y: 41 },
  developer: { x: 49, y: 57 },
  secretary: { x: 69, y: 57 },
  ceo:       { x: 64, y: 77 }
};

function getHomeXY(agentId){
  const p = HOME_POS[agentId] || { x: 50, y: 50 };
  return { x: p.x, y: p.y };
}




function makeAgent(a){
  const home = getHomeXY(a.id);
  const d = document.createElement('div');
  d.className = 'agent idle';
  d.dataset.agent = a.id;
  d.dataset.homeX = home.x;
  d.dataset.homeY = home.y;
  d.dataset.dir = 'down';
  d.style.setProperty('--ag-color', a.color);
  d.style.setProperty('--ag-color-glow', a.color + '55');
  positionAgentToImageCoord(d, home.x, home.y);
  
  /* Sprite character */
  const character = document.createElement('div');
  character.className = 'character';
  if (a.sprite) {
    character.style.backgroundImage = 'url(' + a.sprite + ')';
  } else {
    /* Fallback to CEO sprite if missing */
    character.style.background = 'rgba(255,255,255,0.1)';
  }
  
  const led = document.createElement('span'); led.className = 'ag-led'; d.appendChild(led);
  d.appendChild(character);
  const nm = document.createElement('div'); nm.className = 'ag-plate'; nm.textContent = a.emoji + ' ' + a.name; d.appendChild(nm);
  d.title = a.role + ' — ' + a.specialty;
  d.addEventListener('click', () => openAgentProfile(a.id));
  return d;
}

/** Position agent at (xPct, yPct) as % of stageInner — which has the same
    bounds as the office bg image (CSS aspect-ratio), so coords map 1:1.
    Higher y = renders in front (depth-sort), so agents farther down the
    office naturally occlude ones above them. */
function positionAgentToImageCoord(el, xPct, yPct){
  el.style.left = 'calc(' + xPct + '% - 24px)';
  el.style.top  = 'calc(' + yPct + '% - 96px)';
  el.style.zIndex = String(10 + Math.floor(yPct * 10));
}

function repositionAllAgents(){
  agents.forEach(a => {
    const el = deskEls[a.id]; if (!el) return;
    const x = parseFloat(el.dataset.homeX), y = parseFloat(el.dataset.homeY);
    positionAgentToImageCoord(el, x, y);
  });
  /* Re-anchor location markers to image coords too */
  positionLocations();
}

function positionLocations(){
  const bgEl = document.getElementById('officeBg');
  const fr = floor.getBoundingClientRect();
  if (!bgEl || !bgEl.complete || !bgEl.naturalWidth) return;
  const iw = bgEl.clientWidth, ih = bgEl.clientHeight;
  const ix = (fr.width - iw) / 2;
  const iy = (fr.height - ih) / 2;
  Object.keys(LOCATIONS).forEach(id => {
    const def = LOCATIONS[id];
    const el = document.querySelector('[data-loc="'+id+'"]');
    if (!el) return;
    const px = ix + (def.x / 100) * iw;
    const py = iy + (def.y / 100) * ih;
    el.style.left = px + 'px';
    el.style.top  = py + 'px';
  });
}

function setDeskState(agentId, state, task){
  const d = deskEls[agentId]; if (!d) return;
  d.classList.remove('idle','thinking','working','done');
  d.classList.add(state);
  const old = d.querySelector('.bubble'); if (old) old.remove();
  if (task && (state === 'working' || state === 'thinking')) {
    const b = document.createElement('div'); b.className = 'bubble'; b.textContent = task;
    d.appendChild(b);
    setTimeout(() => { try { b.style.opacity = '0'; setTimeout(() => b.remove(), 350); } catch{} }, 3500);
  }
}

function showBubbleOn(agentId, text, ms){
  const d = deskEls[agentId]; if (!d) return;
  const old = d.querySelector('.bubble'); if (old) old.remove();
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  d.appendChild(b);
  const dur = ms || 2500;
  setTimeout(() => { try { b.style.opacity = '0'; setTimeout(() => b.remove(), 350); } catch{} }, dur);
}

function resetAllDesks(){
  Object.keys(deskEls).forEach(id => setDeskState(id, 'idle'));
  if (beams) beams.innerHTML = '';
  whiteboard.classList.remove('active');
  whiteboard.innerHTML = '대기 중 — 명령을 내리면 팀이 움직입니다';
}

/* ==== Auto-walking + idle chat ==== */
let autoWalkActive = false;
const IDLE_CHATS = [
  '커피 한잔?', '오늘 진도 어때?', '아 그거 봤어?', '점심 뭐 먹지', '와 대박',
  '확인해볼게', '체크', '오케이', '굿', '음...', '잠깐만', '나중에 얘기하자'
];
function pickRandom(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

function walkToward(agentId, targetXPct, targetYPct, durationMs){
  const el = deskEls[agentId]; if (!el) return Promise.resolve();
  const currentX = parseFloat(el.style.left.replace(/[^-0-9.]/g, '')) || 0; // Simplified check
  const currentY = parseFloat(el.style.top.replace(/[^-0-9.]/g, '')) || 0;
  
  /* Determine direction */
  const dx = targetXPct - parseFloat(el.dataset.currX || el.dataset.homeX);
  const dy = targetYPct - parseFloat(el.dataset.currY || el.dataset.homeY);
  if (Math.abs(dx) > Math.abs(dy)) {
    el.dataset.dir = dx > 0 ? 'right' : 'left';
  } else {
    el.dataset.dir = dy > 0 ? 'down' : 'up';
  }
  el.dataset.currX = targetXPct;
  el.dataset.currY = targetYPct;

  el.classList.add('walking');
  positionAgentToImageCoord(el, targetXPct, targetYPct);
  return new Promise(resolve => {
    setTimeout(() => { el.classList.remove('walking'); resolve(); }, durationMs || 1000);
  });
}

/* ===== Visit locations — WORLD %-coords (1400×700 campus canvas) =====
   Campus: Office (center-right), Cafe (left), Garden (right + outside).
   These ids are referenced by PERSONALITY.likedLocs and visitLocationStep. */
const LOCATIONS = {
  cafeCounter: { x: 21, y: 39, label:'☕ 카페 카운터',     emoji:'☕', stay: 4000 },
  cafeTable:   { x: 22, y: 75, label:'🪑 카페 테이블',     emoji:'🪑', stay: 5000 },
  meeting:     { x: 49, y: 78, label:'📊 회의실',          emoji:'📊', stay: 4500 },
  copier:      { x: 70, y: 18, label:'🖨️ 복사실',          emoji:'🖨️', stay: 3500 },
  gardenBench: { x: 85, y: 32, label:'🌳 정원 벤치',       emoji:'🌳', stay: 5500 },
  gardenTree:  { x: 92, y: 86, label:'🌲 큰 나무 아래',    emoji:'🌲', stay: 6000 },
  gardenWalk:  { x: 78, y: 60, label:'🚶 잔디 산책',       emoji:'🚶', stay: 4500 }
};

/* Per-agent personality — drives thoughts, status preferences, location bias.
   likedLocs reference LOCATIONS keys (conference/copier/water/plants/ceoDoor). */
const PERSONALITY = {
  ceo: {
    thoughts: ['이번 분기 목표가...', '회사 비전 정리해야', '다음 큰 그림은?', '팀 잘 굴러가나', 'KPI 다시 봐야겠다'],
    status: ['🧠','💼','📋','🎯'],
    likedLocs: ['meeting','gardenBench','cafeCounter']
  },
  youtube: {
    thoughts: ['다음 썸네일 뭐로?', '오프닝 5초가 핵심', '트렌드 봐야지', '편집 컷 좀 줄이자', '구독자 반응 어떨까'],
    status: ['🎥','📹','💡','🔥','▶️'],
    likedLocs: ['cafeCounter','meeting','gardenWalk']
  },
  designer: {
    thoughts: ['색감이 뭔가 부족한데', '여백을 더...', '폰트 다시 골라야', '레퍼런스 찾자', '톤앤매너가 안 맞아'],
    status: ['🎨','💜','✏️','💡','✨'],
    likedLocs: ['gardenBench','copier','cafeTable']
  },
  instagram: {
    thoughts: ['릴스 트렌드 체크', '해시태그 뭘로?', '커버 이미지가 약해', '댓글 톤이 좋네', '피드 구성 다시'],
    status: ['📸','💖','🌸','✨','📱'],
    likedLocs: ['gardenBench','cafeTable','gardenWalk']
  },
  developer: {
    thoughts: ['이거 캐시해야', '버그 어디서 났지', '리팩터 해야 하는데', '...아 그게 그구나', '커피 한 잔 더'],
    status: ['💻','⌨️','🐛','💡','☕'],
    likedLocs: ['cafeCounter','copier','gardenTree']
  },
  business: {
    thoughts: ['ROI 계산 다시', '단가 협상해야', '월 마감 보자', '현금흐름은 OK', '채널별 수익 분리'],
    status: ['💰','📈','💼','📊','💹'],
    likedLocs: ['meeting','copier','cafeCounter']
  },
  secretary: {
    thoughts: ['일정 정리하자', '메일 답장 보내야', 'CEO 미팅 30분 후', '다들 할 일 알지?', '회의록 다시 보자'],
    status: ['📋','📞','📅','📝','✉️'],
    likedLocs: ['copier','meeting','cafeTable']
  }
};

/* Show small status icon above an agent's head (auto-fades) */
function showStatusIcon(agentId, icon, ms){
  const d = deskEls[agentId]; if (!d) return;
  const old = d.querySelector('.ag-status'); if (old) old.remove();
  const s = document.createElement('div'); s.className='ag-status'; s.textContent = icon;
  d.appendChild(s);
  const dur = ms || 3500;
  setTimeout(() => { try { s.classList.add('fade'); setTimeout(()=>s.remove(),350); } catch{} }, dur);
}

/* Show dotted thought bubble (.oO style — inner monologue) */
function showThought(agentId, text, ms){
  const d = deskEls[agentId]; if (!d) return;
  const old = d.querySelector('.thought'); if (old) old.remove();
  const t = document.createElement('div'); t.className='thought'; t.textContent = '· '+text;
  d.appendChild(t);
  const dur = ms || 3500;
  setTimeout(() => { try { t.style.opacity='0'; setTimeout(()=>t.remove(),350); } catch{} }, dur);
}

async function idleChatStep(){
  if (!autoWalkActive) return;
  const idleAgents = agents.filter(a => {
    const el = deskEls[a.id];
    return el && (el.classList.contains('idle') || el.classList.contains('done'));
  });
  if (idleAgents.length < 2) return;
  const A = pickRandom(idleAgents);
  let B = pickRandom(idleAgents);
  let tries = 0;
  while (B.id === A.id && tries < 5) { B = pickRandom(idleAgents); tries++; }
  if (B.id === A.id) return;
  const bEl = deskEls[B.id]; if (!bEl) return;
  const bx = parseFloat(bEl.dataset.homeX), by = parseFloat(bEl.dataset.homeY);
  const aHomeX = parseFloat(deskEls[A.id].dataset.homeX);
  const aHomeY = parseFloat(deskEls[A.id].dataset.homeY);
  const ax = bx + (aHomeX > bx ? 7 : -7);
  const ay = by + (aHomeY > by ? 5 : -5);
  showStatusIcon(A.id, '💬', 4500);
  await walkToward(A.id, ax, ay, 1100);
  showBubbleOn(A.id, pickRandom(IDLE_CHATS), 1800);
  logActivity(A.emoji, A.id, '<strong>'+A.name+'</strong> → '+B.emoji+' '+B.name+' (잡담)');
  await new Promise(r => setTimeout(r, 1400));
  if (Math.random() < 0.7) {
    showStatusIcon(B.id, '💬', 2500);
    showBubbleOn(B.id, pickRandom(IDLE_CHATS), 1800);
    await new Promise(r => setTimeout(r, 1400));
  }
  await walkToward(A.id, aHomeX, aHomeY, 1100);
}

/* Visit a location, idle there, return — Smallville routine */
async function visitLocationStep(){
  if (!autoWalkActive) return;
  const idleAgents = agents.filter(a => {
    const el = deskEls[a.id];
    return el && (el.classList.contains('idle') || el.classList.contains('done'));
  });
  if (idleAgents.length === 0) return;
  const A = pickRandom(idleAgents);
  const persona = PERSONALITY[A.id] || { likedLocs:['coffee'], status:['💭'] };
  const locId = pickRandom(persona.likedLocs);
  const loc = LOCATIONS[locId]; if (!loc) return;
  const aHomeX = parseFloat(deskEls[A.id].dataset.homeX);
  const aHomeY = parseFloat(deskEls[A.id].dataset.homeY);
  /* offset so multiple agents at same location don't perfectly overlap */
  const offX = (Math.random() - 0.5) * 5;
  showStatusIcon(A.id, loc.emoji, loc.stay + 2400);
  logActivity(loc.emoji, A.id, '<strong>'+A.name+'</strong> → '+loc.label);
  /* mark location active */
  const locEl = document.querySelector('[data-loc="'+locId+'"]');
  if (locEl) locEl.classList.add('active');
  await walkToward(A.id, loc.x + offX, loc.y, 1300);
  await new Promise(r => setTimeout(r, loc.stay));
  if (locEl) locEl.classList.remove('active');
  await walkToward(A.id, aHomeX, aHomeY, 1300);
}

/* Think alone at desk — generate a personality thought */
async function thinkStep(){
  if (!autoWalkActive) return;
  const idleAgents = agents.filter(a => {
    const el = deskEls[a.id];
    return el && (el.classList.contains('idle') || el.classList.contains('done'));
  });
  if (idleAgents.length === 0) return;
  const A = pickRandom(idleAgents);
  const persona = PERSONALITY[A.id] || { thoughts:['...'], status:['💭'] };
  showStatusIcon(A.id, pickRandom(persona.status), 3500);
  showThought(A.id, pickRandom(persona.thoughts), 3500);
}

/* Weighted random action — Smallville-style autonomous behavior */
async function autonomousAct(){
  if (!autoWalkActive) return;
  const r = Math.random();
  if (r < 0.40) await idleChatStep();        /* 40% chitchat */
  else if (r < 0.75) await visitLocationStep(); /* 35% visit a place */
  else await thinkStep();                       /* 25% inner thought */
}

function startAutoWalk(){
  if (autoWalkActive) return;
  autoWalkActive = true;
  logActivity('🚶','ceo','자율 모드 ON — 에이전트들이 일과를 시작합니다.');
  startChatterAutofire();
  const tick = async () => {
    if (!autoWalkActive) return;
    try { await autonomousAct(); } catch {}
    /* 14~32초 사이 랜덤 간격 — 더 활발하게 */
    const next = 14000 + Math.floor(Math.random() * 18000);
    setTimeout(tick, next);
  };
  setTimeout(tick, 6000);
}
function stopAutoWalk(){
  autoWalkActive = false;
  stopChatterAutofire();
  logActivity('🛑','ceo','자율 모드 OFF');
}

/* ===== Ambient particles — drifting glow dots ===== */
function spawnParticles(){
  const container = document.getElementById('particles'); if (!container) return;
  container.innerHTML = '';
  const count = 14;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.style.left = (Math.random() * 100) + '%';
    p.style.bottom = '0';
    p.style.animationDuration = (10 + Math.random() * 8) + 's';
    p.style.animationDelay = (-Math.random() * 14) + 's';
    /* color variety: green/cyan/violet */
    const c = Math.random();
    if (c < 0.5) { /* green default */ }
    else if (c < 0.8) { p.style.background='rgba(34,211,238,.45)'; p.style.boxShadow='0 0 4px rgba(34,211,238,.7)'; }
    else { p.style.background='rgba(167,139,250,.45)'; p.style.boxShadow='0 0 4px rgba(167,139,250,.7)'; }
    container.appendChild(p);
  }
}

/* ===== HUD ticker — DAY / TIME / OUTPUT / WORKING ===== */
let hudOutputCount = 0;
let hudDayNum = 1;
let hudVirtualMin = 9 * 60;  /* in-office time, starts 09:00 */
let hudInterval = null;
function startHud(){
  if (hudInterval) clearInterval(hudInterval);
  const dayEl = document.getElementById('hudDay');
  const timeEl = document.getElementById('hudTime');
  const outEl = document.getElementById('hudOutput');
  const wrkEl = document.getElementById('hudWorking');
  const wrkStatEl = document.getElementById('hudWorkingStat');
  const meta = document.getElementById('topMeta');
  const update = () => {
    /* virtual time: 1 real second = 30 virtual sec → 1 work day (8 hours) ≈ 16 real min */
    hudVirtualMin = (hudVirtualMin + 0.5);
    if (hudVirtualMin >= 18 * 60) { hudVirtualMin = 9 * 60; hudDayNum++; if (dayEl) dayEl.textContent = hudDayNum; logActivity('🌅','ceo','<strong>DAY '+hudDayNum+'</strong> 시작.'); }
    const hh = Math.floor(hudVirtualMin / 60);
    const mm = Math.floor(hudVirtualMin % 60);
    if (timeEl) timeEl.textContent = String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
    if (outEl) outEl.textContent = hudOutputCount;
    /* count agents currently working/thinking */
    let working = 0;
    agents.forEach(a => {
      const el = deskEls[a.id];
      if (el && (el.classList.contains('working') || el.classList.contains('thinking'))) working++;
    });
    if (wrkEl) wrkEl.textContent = working + '/' + agents.length;
    if (wrkStatEl) wrkStatEl.classList.toggle('warn', working > 0);
    if (meta) meta.textContent = '에이전트 '+agents.length+'명 · '+(working > 0 ? working+'명 작업 중' : '대기 중');
  };
  hudInterval = setInterval(update, 1000);
  update();
}
function bumpOutput(){ hudOutputCount++; const el = document.getElementById('hudOutput'); if (el) el.textContent = hudOutputCount; }

/* ===== Per-agent connection / API config field schema ===== */
const AGENT_CONFIG_FIELDS = {
  ceo: [
    { key:'company_vision', label:'회사 비전', type:'textarea', help:'한 문장으로 요약. 모든 에이전트가 의사결정 시 참고합니다.' },
    { key:'company_values', label:'핵심 가치', type:'textarea', help:'쉼표로 구분된 키워드. 예: 빠른 실행, 사용자 중심' },
    { key:'monthly_target', label:'월 목표', type:'text', help:'예: 매출 ₩1,000만 / 영상 8개 / 팔로워 +5,000' }
  ],
  youtube: [
    { key:'channel_id', label:'YouTube 채널 ID', type:'text', placeholder:'UCxxx...' },
    { key:'channel_handle', label:'채널 핸들', type:'text', placeholder:'@mychannel' },
    { key:'api_key', label:'YouTube Data API 키', type:'password', help:'console.cloud.google.com에서 발급. 트렌드 조회/통계용.' },
    { key:'content_focus', label:'주력 콘텐츠 주제', type:'textarea', help:'예: AI 도구 리뷰, 자동화 워크플로우' }
  ],
  instagram: [
    { key:'username', label:'인스타그램 핸들', type:'text', placeholder:'@yourhandle' },
    { key:'access_token', label:'Graph API Access Token', type:'password', help:'Meta for Developers에서 발급. 게시/통계용.' },
    { key:'business_account_id', label:'비즈니스 계정 ID', type:'text' },
    { key:'aesthetic', label:'피드 톤앤매너', type:'textarea', help:'예: 미니멀 / 비비드 / 다크모노' }
  ],
  designer: [
    { key:'figma_token', label:'Figma Personal Access Token', type:'password', help:'figma.com/settings → Personal access tokens' },
    { key:'brand_colors', label:'브랜드 컬러 (HEX, 쉼표)', type:'text', placeholder:'#FF0033, #FFD700' },
    { key:'preferred_fonts', label:'선호 폰트', type:'text', placeholder:'Pretendard, Inter' },
    { key:'design_system', label:'디자인 시스템 메모', type:'textarea' }
  ],
  developer: [
    { key:'github_token', label:'GitHub Personal Access Token', type:'password', help:'github.com/settings/tokens — repo + workflow 권한 필요' },
    { key:'default_repo', label:'기본 저장소 (owner/repo)', type:'text', placeholder:'wonseokjung/connect-ai' },
    { key:'preferred_stack', label:'선호 기술 스택', type:'text', placeholder:'TypeScript, Next.js, PostgreSQL' },
    { key:'deploy_target', label:'배포 환경', type:'text', placeholder:'Vercel / 자체 서버' }
  ],
  business: [
    { key:'currency', label:'기본 통화', type:'text', placeholder:'KRW' },
    { key:'monthly_target_revenue', label:'월 목표 매출', type:'text', placeholder:'₩1,000만' },
    { key:'payment_provider', label:'결제 서비스', type:'text', placeholder:'Toss / Stripe / PayPal' },
    { key:'tax_rate', label:'세율 / 부가세 정책', type:'text', placeholder:'간이과세 / 일반과세' },
    { key:'revenue_streams', label:'수익 채널', type:'textarea', help:'예: 광고 / 멤버십 / 상품 판매' }
  ],
  secretary: [
    { key:'google_calendar_id', label:'Google Calendar ID', type:'text', placeholder:'primary 또는 yourcal@group.calendar.google.com' },
    { key:'google_oauth_token', label:'Google OAuth Token', type:'password', help:'OAuth 2.0 Playground 또는 자체 발급' },
    { key:'telegram_bot_token', label:'Telegram Bot Token', type:'password', help:'@BotFather에서 봇 만들고 토큰 받기' },
    { key:'telegram_chat_id', label:'Telegram Chat ID', type:'text', placeholder:'본인 chat_id (숫자)', help:'@userinfobot으로 확인' },
    { key:'work_hours', label:'근무 시간', type:'text', placeholder:'09:00–18:00' }
  ]
};

/* ===== Agent profile modal (in-UI panel) ===== */
let _profileAgentId = null;
function openAgentProfile(agentId){
  const a = agentMap[agentId]; if (!a) return;
  _profileAgentId = agentId;
  const backdrop = document.getElementById('agentModalBackdrop');
  const modal = document.getElementById('agentModal');
  const emoji = document.getElementById('amdEmoji');
  const name = document.getElementById('amdName');
  const role = document.getElementById('amdRole');
  const state = document.getElementById('amdState');
  const specialty = document.getElementById('amdSpecialty');
  const memory = document.getElementById('amdMemory');
  const decisions = document.getElementById('amdDecisions');
  const sessions = document.getElementById('amdSessions');
  const sessionList = document.getElementById('amdSessionList');
  if (emoji) emoji.textContent = a.emoji;
  if (name) name.textContent = a.name;
  if (role) role.textContent = a.role;
  if (specialty) specialty.textContent = a.specialty || '—';
  const el = deskEls[agentId];
  let cur = 'IDLE';
  if (el) {
    if (el.classList.contains('working')) cur = 'WORKING';
    else if (el.classList.contains('thinking')) cur = 'THINKING';
    else if (el.classList.contains('done')) cur = 'DONE';
  }
  if (state) state.textContent = cur;
  if (memory) memory.textContent = '불러오는 중…';
  if (decisions) decisions.textContent = '불러오는 중…';
  if (sessions) sessions.textContent = '…';
  if (sessionList) sessionList.innerHTML = '';
  /* render config form */
  renderConfigForm(agentId, {});
  modal.style.setProperty('--ag-color', a.color);
  modal.style.setProperty('--ag-color-glow', a.color + '55');
  if (backdrop) backdrop.removeAttribute('hidden');
  vscode.postMessage({ type: 'agentProfileRequest', agent: agentId });
  vscode.postMessage({ type: 'agentConfigRequest', agent: agentId });
}
function closeAgentProfile(){
  _profileAgentId = null;
  const backdrop = document.getElementById('agentModalBackdrop');
  if (backdrop) backdrop.setAttribute('hidden','');
}

function renderConfigForm(agentId, values){
  const form = document.getElementById('amdConfigForm');
  if (!form) return;
  const fields = AGENT_CONFIG_FIELDS[agentId] || [];
  if (fields.length === 0) {
    form.innerHTML = '<span style="font-size:10px;color:var(--text-dim)">이 에이전트는 별도 외부 연결 설정이 없습니다.</span>';
    return;
  }
  form.innerHTML = '';
  fields.forEach(f => {
    const wrap = document.createElement('div');
    wrap.className = 'amd-field';
    const lbl = document.createElement('label');
    lbl.className = 'amd-field-lbl';
    lbl.textContent = f.label;
    wrap.appendChild(lbl);
    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = (f.type === 'password') ? 'password' : 'text';
    }
    input.className = 'amd-input';
    input.dataset.key = f.key;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (values && values[f.key] !== undefined) input.value = values[f.key];
    wrap.appendChild(input);
    if (f.help) {
      const help = document.createElement('div');
      help.className = 'amd-field-help';
      help.textContent = f.help;
      wrap.appendChild(help);
    }
    form.appendChild(wrap);
  });
}

function collectConfigValues(){
  const form = document.getElementById('amdConfigForm');
  if (!form) return {};
  const out = {};
  form.querySelectorAll('[data-key]').forEach(el => {
    out[el.dataset.key] = el.value || '';
  });
  return out;
}

function saveAgentConfig(){
  if (!_profileAgentId) return;
  const values = collectConfigValues();
  const status = document.getElementById('amdSaveStatus');
  if (status) { status.className = 'amd-save-status show'; status.textContent = '저장 중…'; }
  vscode.postMessage({ type:'saveAgentConfig', agent: _profileAgentId, values });
}

(function(){
  const closeBtn = document.getElementById('amdClose');
  if (closeBtn) closeBtn.addEventListener('click', closeAgentProfile);
  /* Click on backdrop (outside modal box) closes too */
  const backdrop = document.getElementById('agentModalBackdrop');
  if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAgentProfile(); });
  /* Esc closes */
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _profileAgentId) closeAgentProfile(); });
  const ofb = document.getElementById('amdOpenFolder');
  if (ofb) ofb.addEventListener('click', () => { if (_profileAgentId) vscode.postMessage({ type:'openCompanyFolder', sub:'_agents/'+_profileAgentId }); });
  const sfb = document.getElementById('amdSaveConfig');
  if (sfb) sfb.addEventListener('click', saveAgentConfig);
  const pfb = document.getElementById('pickFolderBtn');
  if (pfb) pfb.addEventListener('click', () => vscode.postMessage({ type:'pickCompanyFolder' }));
})();

/* ===== Brain integration visual ===== */
function pulseBrain(agentId, reason){
  const locEl = document.querySelector('[data-loc="brain"]');
  if (locEl) {
    locEl.classList.add('active');
    setTimeout(()=>locEl.classList.remove('active'), 2200);
  }
  if (agentId) showStatusIcon(agentId, '🧠', 2400);
  if (reason) {
    const a = agentMap[agentId];
    logActivity('🧠', agentId || 'ceo', '<strong>'+(a?a.name:'에이전트')+'</strong> 두뇌 열람: '+reason);
  }
}

function logActivity(emoji, agentId, text){
  const a = agentMap[agentId];
  const e = document.createElement('div'); e.className = 'log-entry';
  if (a) e.style.setProperty('--ag-color', a.color);
  const t = new Date(); const hh = String(t.getHours()).padStart(2,'0'), mm = String(t.getMinutes()).padStart(2,'0'), ss = String(t.getSeconds()).padStart(2,'0');
  e.innerHTML = '<span class="log-time">'+hh+':'+mm+':'+ss+'</span><span class="log-emoji">'+emoji+'</span><span class="log-text">'+text+'</span>';
  logPane.appendChild(e);
  logPane.scrollTop = logPane.scrollHeight;
}

function startOutCard(agentId, task){
  const a = agentMap[agentId]; if (!a) return;
  /* Clear empty state once */
  const empty = outPane.querySelector('.empty'); if (empty) empty.remove();
  const card = document.createElement('div');
  card.className = 'out-card';
  card.style.setProperty('--ag-color', a.color);
  card.innerHTML = '<div class="out-head">'+a.emoji+' '+a.name+' <span class="oh-task">— '+escapeHtml(task||'')+'</span></div><div class="out-body"></div>';
  outPane.appendChild(card);
  outPane.scrollTop = outPane.scrollHeight;
  outCardEls[agentId] = { card: card, body: card.querySelector('.out-body'), raw: '' };
}
function appendOutChunk(agentId, value){
  let c = outCardEls[agentId];
  if (!c) { startOutCard(agentId, ''); c = outCardEls[agentId]; }
  if (!c) return;
  c.raw = (c.raw||'') + value;
  c.body.textContent = c.raw;
  outPane.scrollTop = outPane.scrollHeight;
}
function endOutCard(agentId){ delete outCardEls[agentId]; }

function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function drawBeams(taskAgentIds){
  if (!beams || !deskEls.ceo) return;
  beams.innerHTML = '';
  const fr = floor.getBoundingClientRect();
  const ceoR = deskEls.ceo.getBoundingClientRect();
  const cx = ceoR.left + ceoR.width/2 - fr.left;
  const cy = ceoR.top + ceoR.height/2 - fr.top;
  const w = fr.width, h = fr.height;
  beams.setAttribute('viewBox','0 0 '+w+' '+h);
  beams.setAttribute('width', w); beams.setAttribute('height', h);
  taskAgentIds.forEach((id, i) => {
    const desk = deskEls[id]; if (!desk || id==='ceo') return;
    const r = desk.getBoundingClientRect();
    const tx = r.left + r.width/2 - fr.left;
    const ty = r.top + r.height/2 - fr.top;
    const mx = (cx+tx)/2, my = (cy+ty)/2 - 30;
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M '+cx+' '+cy+' Q '+mx+' '+my+' '+tx+' '+ty);
    path.setAttribute('class','beam');
    const a = agentMap[id];
    if (a) { path.style.stroke = a.color; path.style.filter = 'drop-shadow(0 0 6px '+a.color+')'; }
    path.style.animationDelay = (i*0.08)+'s';
    beams.appendChild(path);
  });
}

function setSending(v){ cmdSend.disabled = v; cmdInput.disabled = v; }
function send(){
  const text = (cmdInput.value || '').trim();
  if (!text) return;
  setSending(true);
  logActivity('👤','ceo','명령: <strong>'+escapeHtml(text)+'</strong>');
  vscode.postMessage({ type: 'officePrompt', value: text });
  cmdInput.value = '';
}
cmdSend.addEventListener('click', send);
cmdInput.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send(); }});
folderBtn.addEventListener('click', () => vscode.postMessage({ type: 'openCompanyFolder' }));
/* Manual + auto chatter — ask backend to generate one round of agent dialogue.
   Local Gemma is free so we tie auto-fire to autoWalk: every 90s when on. */
const chatterBtn = document.getElementById('chatterBtn');
let _chatterTimer = null;
function startChatterAutofire(){
  if (_chatterTimer) return;
  _chatterTimer = setInterval(() => {
    try { vscode.postMessage({ type: 'runChatter' }); } catch {}
  }, 90000);
}
function stopChatterAutofire(){
  if (_chatterTimer) { clearInterval(_chatterTimer); _chatterTimer = null; }
}
chatterBtn && chatterBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'runChatter' });
});
/* Side panel toggle — start collapsed so the map gets all the room */
const sideEl = document.querySelector('.side');
const toggleSideBtn = document.getElementById('toggleSideBtn');
if (sideEl) sideEl.classList.add('collapsed');
if (toggleSideBtn && sideEl) {
  toggleSideBtn.addEventListener('click', () => {
    sideEl.classList.toggle('collapsed');
    toggleSideBtn.style.color = sideEl.classList.contains('collapsed') ? '' : 'var(--accent)';
    /* Re-fit world canvas after panel width change */
    setTimeout(() => { try { fitAndScale(); } catch {} window.dispatchEvent(new Event('resize')); }, 280);
  });
}
const roomSelect = document.getElementById('roomSelect');
let activeRoomAgents = null;     /* string[] | null — null means all agents visible (legacy) */
let activeRoomHomePos = null;    /* {agentId: {x,y}} | null */
let activeAnimations = [];       /* [{src,x,y,w}] */
roomSelect && roomSelect.addEventListener('change', () => {
  vscode.postMessage({ type: 'setRoom', roomId: roomSelect.value });
});
/* === Connected campus world — Office + Cafe + Garden in one coord space === */
let officeZones = [];           /* [{id,name,emoji,x,y}] world % */
let worldData = null;           /* { worldWidth, worldHeight, buildings, decorations, ... } */
const stageInner = document.getElementById('stageInner');

function renderWorldGrass(){
  const grass = document.getElementById('worldGrass');
  if (!grass || !worldData || !worldData.grassUri) return;
  /* Tile size = (48 / worldWidth) * 100% so each tile maps to one 48-px
     LimeZu tile in world coordinates. With % units, the grass scales with
     stageInner without becoming pixelated mush. */
  const tilePctW = (48 / worldData.worldWidth) * 100;
  const tilePctH = (48 / worldData.worldHeight) * 100;
  grass.style.backgroundImage = 'url(' + worldData.grassUri + ')';
  grass.style.backgroundSize = tilePctW + '% ' + tilePctH + '%';
}

function renderWorldPaths(){
  const wrap = document.getElementById('worldPaths');
  if (!wrap || !worldData) return;
  wrap.innerHTML = '';
  if (!worldData.pathUri || !Array.isArray(worldData.paths)) return;
  const W = worldData.worldWidth, H = worldData.worldHeight;
  /* Path tile is 48px native; render at one tile per 48 world-px. */
  const tilePctW = (48 / W) * 100;
  const tilePctH = (48 / H) * 100;
  worldData.paths.forEach(p => {
    const strip = document.createElement('div');
    strip.className = 'path-strip';
    strip.style.left   = (p.x / W) * 100 + '%';
    strip.style.top    = (p.y / H) * 100 + '%';
    strip.style.width  = (p.w / W) * 100 + '%';
    strip.style.height = (p.h / H) * 100 + '%';
    strip.style.backgroundImage = 'url(' + worldData.pathUri + ')';
    /* Sub-strip background-size needs to express tile size as % of THIS
       strip, not the world. Convert: tile_strip% = world_tilePct / strip_pct. */
    strip.style.backgroundSize =
      (48 / p.w * 100) + '% ' + (48 / p.h * 100) + '%';
    wrap.appendChild(strip);
  });
}

function renderWorldBuildings(){
  const wrap = document.getElementById('worldBuildings');
  if (!wrap || !worldData) return;
  wrap.innerHTML = '';
  const W = worldData.worldWidth, H = worldData.worldHeight;
  worldData.buildings.forEach(b => {
    const leftPct  = (b.x / W) * 100;
    const topPct   = (b.y / H) * 100;
    const widthPct = (b.width / W) * 100;
    const heightPct= (b.height / H) * 100;
    if (b.layer1Uri) {
      const im = document.createElement('img');
      im.src = b.layer1Uri; im.alt = '';
      im.style.left = leftPct + '%';
      im.style.top  = topPct + '%';
      im.style.width = widthPct + '%';
      im.style.height = heightPct + '%';
      im.style.zIndex = '1';
      wrap.appendChild(im);
    }
    if (b.layer2Uri) {
      const im2 = document.createElement('img');
      im2.src = b.layer2Uri; im2.alt = '';
      im2.style.left = leftPct + '%';
      im2.style.top  = topPct + '%';
      im2.style.width = widthPct + '%';
      im2.style.height = heightPct + '%';
      im2.style.zIndex = '2';
      wrap.appendChild(im2);
    }
  });
}

function renderWorldDecorations(){
  const wrap = document.getElementById('worldDecor');
  if (!wrap || !worldData) return;
  wrap.innerHTML = '';
  const W = worldData.worldWidth;
  // Each decoration is 48px native — render at (48/W)*100 % wide so the
  // pixel-art stays consistent regardless of stage size.
  const decorWPct = (48 / W) * 100;
  worldData.decorations.forEach(d => {
    const img = document.createElement('img');
    img.src = d.uri; img.alt = '';
    img.style.left = d.x + '%';
    img.style.top  = d.y + '%';
    img.style.width = (d.w || decorWPct) + '%';
    /* depth-sort: decorations farther down render in front of higher ones */
    img.style.zIndex = String(Math.floor(d.y * 10));
    wrap.appendChild(img);
  });
}

function renderOfficeZones(zones){
  const wrap = document.getElementById('officeZones');
  if (!wrap) return;
  wrap.innerHTML = '';
  (zones || []).forEach(z => {
    const lbl = document.createElement('div');
    lbl.className = 'zone-label';
    lbl.textContent = (z.emoji || '') + ' ' + z.name;
    lbl.style.left = z.x + '%';
    lbl.style.top  = z.y + '%';
    wrap.appendChild(lbl);
  });
}

/* Resize stageInner to the largest world-aspect rect that fits in the
   office-stage container. World aspect comes from worldData (1400/700 = 2.0). */
function fitStage(){
  const stage = document.getElementById('officeStage');
  const inner = document.getElementById('stageInner');
  if (!stage || !inner) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w <= 0 || h <= 0) return;
  const W = (worldData && worldData.worldWidth) || 1400;
  const H = (worldData && worldData.worldHeight) || 700;
  const targetAR = W / H;
  const containerAR = w / h;
  let iw, ih;
  if (containerAR > targetAR) { ih = h; iw = Math.round(h * targetAR); }
  else                         { iw = w; ih = Math.round(w / targetAR); }
  inner.style.width  = iw + 'px';
  inner.style.height = ih + 'px';
}

/* Scale character sprites to MATCH the world's display scale.
   World is rendered at world-px → stage-px ratio. Characters should scale
   the same so they look proportional to the cubicles/furniture baked into
   the bg images. A small bump (×1.05) so name plates stay readable. */
function updateCharScale(){
  const inner = document.getElementById('stageInner');
  if (!inner) return;
  const worldW = (worldData && worldData.worldWidth) || 1400;
  const worldScale = inner.clientWidth / worldW;
  const scale = Math.max(0.35, Math.min(1.6, worldScale * 1.05));
  inner.style.setProperty('--char-scale', scale.toFixed(2));
}

function fitAndScale(){ fitStage(); updateCharScale(); repositionAllAgents(); }

/* Stubs kept so legacy call sites don't crash. */
function applyRoomLayout(){ /* unified office: no per-room swap */ }
function applyAnimations(){ /* unified office: ambient anims belong to bg */ }
const autoBtn = document.getElementById('autoBtn');
autoBtn.addEventListener('click', () => {
  if (autoWalkActive) { stopAutoWalk(); autoBtn.textContent = '🚶 자율 OFF'; autoBtn.style.color = ''; }
  else { startAutoWalk(); autoBtn.textContent = '🚶 자율 ON'; autoBtn.style.color = 'var(--accent)'; }
});
/* Re-fit stage + rescale characters + reposition agents on panel resize */
window.addEventListener('resize', fitAndScale);
document.querySelectorAll('.side-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.side-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.side-pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.pane).classList.add('active');
    if (t.dataset.pane === 'convPane') {
      vscode.postMessage({ type: 'loadConversations' });
    }
  });
});
document.getElementById('reloadConvBtn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'loadConversations' });
});

window.addEventListener('message', e => {
  const m = e.data;
  switch (m.type) {
    case 'officeInit': {
      agents = m.agents || [];
      agentMap = {}; deskEls = {};
      agents.forEach(a => { agentMap[a.id] = a; });
      topCompany.textContent = m.companyName || '1인 기업';
      /* Connected campus: world canvas with multiple buildings + decorations.
         Agents share the world coord space (% of stageInner = % of world). */
      worldData = m.world || null;
      if (worldData && worldData.desks) {
        HOME_POS = Object.assign({}, HOME_POS, worldData.desks);
      }
      officeZones = (worldData && Array.isArray(worldData.zones)) ? worldData.zones : [];
      document.body.classList.add('floorplan');
      try {
        const dbg = (m.debug || {});
        console.log('[Connect AI] world init — buildings:', dbg.buildingsLoaded, '/ decor:', dbg.decorationsLoaded, '/ custom map:', dbg.customMap||'none');
        const customNote = (dbg.customMap === 'OK') ? ' · 🎨 커스텀 맵 사용' : '';
        logActivity('🛠','ceo','캠퍼스 v2.28: '+(dbg.buildingsLoaded||0)+'동 + '+(dbg.decorationsLoaded||0)+' 장식'+customNote);
      } catch {}
      /* Hide the room selector — campus view has no room switcher */
      if (roomSelect) roomSelect.style.display = 'none';
      /* Custom map: a user-supplied full-stage PNG overrides procedural world */
      const customMapUri = m.customMapUri || '';
      const stageEl = document.getElementById('stageInner');
      if (customMapUri) {
        if (stageEl) {
          stageEl.style.backgroundImage = 'url(' + customMapUri + ')';
          stageEl.style.backgroundSize = '100% 100%';
          stageEl.style.backgroundPosition = 'center center';
          stageEl.style.backgroundRepeat = 'no-repeat';
        }
        /* Suppress procedural world layers when custom map is used */
        ['worldGrass','worldPaths','worldBuildings','worldDecorations'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = '';
        });
      } else {
        if (stageEl) stageEl.style.backgroundImage = '';
        renderWorldGrass();
        renderWorldPaths();
        renderWorldBuildings();
        renderWorldDecorations();
      }
      renderOfficeZones(officeZones);
      /* Render agents inside stageInner — % coords map onto the world canvas */
      const stage = document.getElementById('stageInner');
      if (stage) stage.querySelectorAll('.agent').forEach(d => d.remove());
      agents.forEach(a => {
        const d = makeAgent(a);
        if (stage) stage.appendChild(d);
        deskEls[a.id] = d;
      });
      fitAndScale();
      /* Re-fit once any building image has loaded so layout settles */
      const firstBld = stage && stage.querySelector('.world-buildings img');
      if (firstBld) { firstBld.addEventListener('load', fitAndScale, { once: true }); }
      setTimeout(fitAndScale, 60);
      setTimeout(fitAndScale, 350);
      
      /* Sprite animation loop — LimeZu Premade_Character_48x48 (cell = 48×96).
         Row 1 (y=96)  = idle / standing.  Cycles 6 frames per direction even when idle (subtle breathing).
         Row 2 (y=192) = walking / typing motion.  6 frames per direction.
         Direction columns: down=0, left=6, right=12, up=18 (each 6 frames). */
      let frameCount = 0;
      const TILE = 48;
      const CHAR_HEIGHT = TILE * 2;  /* = 96 — correct cell height */
      const animateSprites = () => {
        frameCount++;
        agents.forEach(a => {
          const el = deskEls[a.id]; if (!el) return;
          const characterEl = el.querySelector('.character'); if (!characterEl) return;

          let colOffset = 0;
          switch (el.dataset.dir) {
            case 'down':  colOffset = 0;  break;
            case 'left':  colOffset = 6;  break;
            case 'right': colOffset = 12; break;
            case 'up':    colOffset = 18; break;
          }

          let row = 1;  /* idle */
          if (el.classList.contains('walking')) row = 2;
          else if (el.classList.contains('working') || el.classList.contains('thinking')) row = 2;

          /* Animate slower when idle, faster when walking/working */
          const speed = (row === 2) ? 8 : 14;
          const frameIndex = Math.floor(frameCount / speed) % 6;
          const col = colOffset + frameIndex;

          characterEl.style.backgroundPosition = '-' + (col * TILE) + 'px -' + (row * CHAR_HEIGHT) + 'px';
        });
        requestAnimationFrame(animateSprites);
      };
      animateSprites();

      /* reposition once layout settles */
      setTimeout(repositionAllAgents, 100);
      setTimeout(repositionAllAgents, 600);
      /* spawn ambient particles */
      spawnParticles();
      /* start HUD ticker (DAY / TIME / WORKING) */
      startHud();
      /* start auto-walk + first thought after short delay */
      setTimeout(() => startAutoWalk(), 6000);
      setTimeout(() => { agents.forEach(a => { showStatusIcon(a.id, '☕', 2500); }); }, 1200);
      logActivity('🏢','ceo','사무실 가동. 에이전트 '+agents.length+'명 자리 잡음.');
      logActivity('🌅','ceo','오늘 하루 시작.');
      break;
    }
    case 'agentDispatch': {
      currentTasks = m.tasks || [];
      const ids = ['ceo'].concat(currentTasks.map(t => t.agent));
      whiteboard.classList.add('active');
      whiteboard.innerHTML = '<span class="wb-line">📋 '+escapeHtml(m.brief||'')+'</span>';
      currentTasks.forEach(t => setDeskState(t.agent, 'thinking', t.task));
      document.body.classList.add('dispatching');
      setTimeout(() => drawBeams(ids), 50);
      setTimeout(() => { document.body.classList.remove('dispatching'); beams.innerHTML=''; }, 1700);
      logActivity('🧭','ceo','<strong>분배:</strong> '+escapeHtml(m.brief||''));
      currentTasks.forEach(t => {
        const a = agentMap[t.agent];
        if (a) logActivity(a.emoji, t.agent, '<strong>'+a.name+'</strong> ← '+escapeHtml(t.task));
      });
      /* 캐릭터들이 회의실로 모이는 시네마틱 */
      const taskIdsOnly = currentTasks.map(t => t.agent);
      const ceoP = HOME_POS.ceo;
      taskIdsOnly.forEach((id, i) => {
        setTimeout(() => {
          const offX = ((i % 4) - 1.5) * 7;
          const offY = (Math.floor(i / 4)) * 6 + 8;
          walkToward(id, ceoP.x + offX, ceoP.y + offY, 1100);
        }, i * 90);
      });
      setTimeout(() => {
        taskIdsOnly.forEach(id => {
          const el = deskEls[id]; if (!el) return;
          const hx = parseFloat(el.dataset.homeX), hy = parseFloat(el.dataset.homeY);
          walkToward(id, hx, hy, 1100);
        });
      }, 2200);
      break;
    }
    case 'agentStart': {
      setDeskState(m.agent, 'working', m.task);
      const persona = PERSONALITY[m.agent] || { status:['⚡'] };
      showStatusIcon(m.agent, pickRandom(persona.status), 4500);
      if (m.agent !== 'ceo') {
        startOutCard(m.agent, m.task||'');
        const a = agentMap[m.agent];
        if (a) logActivity(a.emoji, m.agent, a.name+' 작업 시작');
      } else {
        const txt = m.task || 'CEO 작업';
        logActivity('🧭','ceo','<strong>CEO</strong> '+escapeHtml(txt));
      }
      break;
    }
    case 'agentChunk': {
      appendOutChunk(m.agent, m.value || '');
      break;
    }
    case 'agentEnd': {
      setDeskState(m.agent, 'done');
      endOutCard(m.agent);
      const a = agentMap[m.agent];
      if (a) logActivity('✅', m.agent, a.name+' 완료');
      showStatusIcon(m.agent, '✨', 2000);
      bumpOutput();
      break;
    }
    case 'corporateReport': {
      whiteboard.classList.add('active');
      whiteboard.innerHTML = '<span class="wb-line">📝 '+escapeHtml((m.brief||'').slice(0,80))+'</span>';
      const block = document.createElement('div'); block.className = 'report-block';
      block.innerHTML = '<div class="rb-head">📝 CEO 종합 보고서</div>'+escapeHtml(m.report||'');
      outPane.appendChild(block);
      outPane.scrollTop = outPane.scrollHeight;
      logActivity('📝','ceo','<strong>종합 보고서 발표</strong> · '+escapeHtml(m.sessionPath||''));
      /* switch to outputs tab */
      document.querySelectorAll('.side-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.side-pane').forEach(x => x.classList.remove('active'));
      document.querySelector('.side-tab[data-pane="outPane"]').classList.add('active');
      outPane.classList.add('active');
      setSending(false);
      setTimeout(() => Object.keys(deskEls).forEach(id => setDeskState(id, 'idle')), 2500);
      break;
    }
    case 'telegramSent': {
      logActivity('📱','secretary','<strong>Secretary</strong> 텔레그램으로 보고 전송');
      break;
    }
    case 'agentConfig': {
      if (m.agent !== _profileAgentId) break;
      renderConfigForm(m.agent, m.values || {});
      break;
    }
    case 'agentConfigSaved': {
      const status = document.getElementById('amdSaveStatus');
      if (!status) break;
      status.className = 'amd-save-status show ' + (m.error ? 'error' : 'success');
      status.textContent = m.error ? ('⚠️ ' + m.error) : '✅ 저장됨 · _agents/' + m.agent + '/connections.md';
      setTimeout(() => { status.classList.remove('show'); }, 2800);
      break;
    }
    case 'agentProfile': {
      if (m.agent !== _profileAgentId) break;  /* user closed or switched */
      const memEl = document.getElementById('amdMemory');
      const decEl = document.getElementById('amdDecisions');
      const sessEl = document.getElementById('amdSessions');
      const listEl = document.getElementById('amdSessionList');
      if (m.error) {
        if (memEl) memEl.textContent = '⚠️ ' + m.error;
        break;
      }
      if (memEl) memEl.textContent = m.memory || '_없음_';
      if (decEl) decEl.textContent = m.decisions || '_없음_';
      if (sessEl) sessEl.textContent = m.sessionCount || 0;
      if (listEl) {
        listEl.innerHTML = '';
        (m.recentSessions || []).forEach(s => {
          const d = document.createElement('div'); d.className='amd-sess'; d.textContent = '· '+s;
          listEl.appendChild(d);
        });
        if ((m.recentSessions || []).length === 0) listEl.textContent = '_세션 기록 없음_';
      }
      break;
    }
    case 'companyFolderChanged': {
      logActivity('📁','ceo','회사 폴더 변경됨 → '+escapeHtml(m.dir||''));
      break;
    }
    case 'conversationsLoaded': {
      const dateEl = document.getElementById('convDate');
      const bodyEl = document.getElementById('convBody');
      if (dateEl) dateEl.textContent = m.date ? '📅 ' + m.date : '';
      if (bodyEl) bodyEl.textContent = m.content || '';
      /* Auto-scroll to latest entry at the bottom */
      const pane = document.getElementById('convPane');
      if (pane) pane.scrollTop = pane.scrollHeight;
      break;
    }
    case 'roomChanged': {
      /* No-op in floor-plan mode: every room is already on screen. */
      break;
    }
    case 'brainRead': {
      pulseBrain(m.agent, m.reason || '');
      break;
    }
    case 'agentConfer': {
      const turns = m.turns || [];
      logActivity('💬','ceo','<strong>자율 회의</strong> ('+turns.length+'턴)');
      /* 자동 walk: 화자가 청자 옆으로 걸어가서 말 → 다시 자기 자리로 */
      let chain = Promise.resolve();
      turns.forEach((t) => {
        chain = chain.then(async () => {
          const fa = agentMap[t.from], ta = agentMap[t.to];
          const fEl = deskEls[t.from], tEl = deskEls[t.to];
          if (!fa || !ta || !fEl || !tEl) return;
          const bx = parseFloat(tEl.dataset.homeX), by = parseFloat(tEl.dataset.homeY);
          const ax = parseFloat(fEl.dataset.homeX);
          const offX = (ax > bx ? 7 : -7);
          await walkToward(t.from, bx + offX, by, 950);
          showBubbleOn(t.from, t.text, 1700);
          logActivity(fa.emoji, t.from, '<strong>'+fa.name+'</strong> → '+ta.emoji+' '+ta.name+': '+escapeHtml(t.text));
          await new Promise(r => setTimeout(r, 1500));
          const hx = parseFloat(fEl.dataset.homeX), hy = parseFloat(fEl.dataset.homeY);
          await walkToward(t.from, hx, hy, 950);
        });
      });
      break;
    }
    case 'decisionsLearned': {
      const decs = m.decisions || [];
      if (decs.length === 0) break;
      logActivity('🧠','ceo','<strong>자가학습</strong> '+decs.length+'개 결정 누적 (decisions.md)');
      const empty = outPane.querySelector('.empty'); if (empty) empty.remove();
      const block = document.createElement('div'); block.className = 'report-block';
      block.style.borderColor = 'rgba(167,139,250,.4)';
      block.style.boxShadow = '0 0 14px rgba(167,139,250,.15)';
      block.innerHTML = '<div class="rb-head" style="color:#A78BFA">🧠 자가학습 · decisions.md</div>'+decs.map(d => '• '+escapeHtml(d)).join('<br>');
      outPane.appendChild(block);
      outPane.scrollTop = outPane.scrollHeight;
      break;
    }
    case 'error': {
      logActivity('⚠️','ceo','<strong>오류:</strong> '+escapeHtml(m.value||''));
      setSending(false);
      break;
    }
  }
});

vscode.postMessage({ type: 'officeReady' });
</script>
</body>
</html>`;
    }
}

// ============================================================
// Sidebar Chat Provider
// ============================================================

class SidebarChatProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _chatHistory: { role: string; content: string }[] = [];
    private _ctx: vscode.ExtensionContext;

    // 대화 표시용 (system prompt 제외, 유저에게 보여줄 것만 저장)
    private _displayMessages: { text: string; role: string }[] = [];
    private _isSyncingBrain: boolean = false;
    public _brainEnabled: boolean = true; // 🧠 ON/OFF 토글 상태
    private _abortController?: AbortController;
    private _lastPrompt?: string;
    private _lastModel?: string;

    // 🎬 Thinking Mode — live cinematic graph that visualises AI reasoning
    private _thinkingMode: boolean = false;
    private _thinkingPanel?: vscode.WebviewPanel;
    private _thinkingReady: boolean = false;
    // Externally-opened brain network panels (메뉴 → 🌐 네트워크 보기) that should
    // also receive thinking events so the user sees the same node pulse / trail.
    private _externalGraphPanels: Set<vscode.WebviewPanel> = new Set();
    public registerExternalGraphPanel(panel: vscode.WebviewPanel) {
        this._externalGraphPanels.add(panel);
        panel.onDidDispose(() => this._externalGraphPanels.delete(panel));
    }

    // 🏢 Office panel broadcast — corporate-mode 메시지를 사이드바와 풀스크린
    // 사무실 패널 양쪽에 동시에 보내기 위한 list. OfficePanel이 자기 webview를 등록.
    private _corporateBroadcastTargets: Set<vscode.Webview> = new Set();
    public registerCorporateBroadcastTarget(webview: vscode.Webview) {
        this._corporateBroadcastTargets.add(webview);
    }
    public unregisterCorporateBroadcastTarget(webview: vscode.Webview) {
        this._corporateBroadcastTargets.delete(webview);
    }
    private _broadcastCorporate(msg: any) {
        try { this._view?.webview.postMessage(msg); } catch { /* ignore */ }
        this._corporateBroadcastTargets.forEach(w => {
            try { w.postMessage(msg); } catch { /* disposed */ }
        });
    }
    /** Notify the sidebar webview that the office panel opened/closed so it can update its UI. */
    public broadcastOfficeState(open: boolean) {
        try { this._view?.webview.postMessage({ type: 'officeStateChanged', open }); } catch { /* ignore */ }
    }

    // 외부 (OfficePanel)에서 명령을 받아 corporate 작업 시작
    public async runCorporatePromptExternal(prompt: string, modelName: string) {
        await this._handleCorporatePrompt(prompt, modelName);
    }
    public async runAutonomousChatter(modelName: string): Promise<void> {
        await this._runAutonomousChatter(modelName);
    }
    public getDefaultModel(): string {
        return getConfig().defaultModel || '';
    }

    /** One round of agent-to-agent ambient chatter. Picks two random specialists,
     *  asks the model for 2-3 short turns of natural workplace dialogue (in
     *  context of recent conversations + company goals), animates the confer in
     *  the office panel, and appends to the daily conversation log. */
    private async _runAutonomousChatter(modelName: string): Promise<void> {
        try {
            ensureCompanyStructure();
            if (!this._abortController) this._abortController = new AbortController();
            const post = (m: any) => this._broadcastCorporate(m);
            // Pick two distinct specialists at random
            const pool = SPECIALIST_IDS.slice();
            if (pool.length < 2) return;
            const i = Math.floor(Math.random() * pool.length);
            let j = Math.floor(Math.random() * pool.length);
            while (j === i) j = Math.floor(Math.random() * pool.length);
            const aFrom = AGENTS[pool[i]];
            const aTo = AGENTS[pool[j]];
            if (!aFrom || !aTo) return;
            const recent = readRecentConversations(1500);
            const goalsPath = path.join(getCompanyDir(), '_shared', 'goals.md');
            const goals = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf-8').slice(0, 1000) : '';
            const sys = `당신은 1인 AI 기업 사무실의 분위기 시뮬레이터입니다. 두 동료가 자연스럽게 짧게 잡담하거나 작업 얘기를 합니다.

⚠️ 반드시 아래 JSON 형식으로만 출력. 마크다운 펜스·머리말·꼬리말 절대 금지.

{
  "turns": [
    {"from": "${aFrom.id}", "to": "${aTo.id}", "text": "30자 이내 한국어"},
    {"from": "${aTo.id}", "to": "${aFrom.id}", "text": "30자 이내 한국어"}
  ]
}

규칙: 2~3턴, 각 30자 이내, 자연스러움. from/to는 정확히 "${aFrom.id}"와 "${aTo.id}"만.`;
            const usr = `[참여자]\n${aFrom.emoji} ${aFrom.name} (${aFrom.role})\n${aTo.emoji} ${aTo.name} (${aTo.role})\n\n[회사 목표]\n${goals}${recent}`;
            const raw = await this._callAgentLLM(sys, usr, modelName, aFrom.id, false);
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) return;
            const parsed = JSON.parse(m[0]);
            if (!parsed || !Array.isArray(parsed.turns)) return;
            const validIds = SPECIALIST_IDS;
            const turns: { from: string; to: string; text: string }[] = [];
            for (const t of parsed.turns) {
                if (typeof t.from === 'string' && typeof t.to === 'string' && typeof t.text === 'string'
                    && validIds.includes(t.from) && validIds.includes(t.to)
                    && t.from !== t.to && t.text.trim().length > 0) {
                    turns.push({ from: t.from, to: t.to, text: t.text.trim().slice(0, 80) });
                }
            }
            if (turns.length === 0) return;
            post({ type: 'agentConfer', turns });
            const body = turns
                .map(t => `- ${AGENTS[t.from]?.emoji || ''} **${AGENTS[t.from]?.name || t.from}** → ${AGENTS[t.to]?.emoji || ''} ${AGENTS[t.to]?.name || t.to}: ${t.text}`)
                .join('\n');
            appendConversationLog({ speaker: '자율 잡담', emoji: '💬', section: `${aFrom.name} ↔ ${aTo.name}`, body });
        } catch { /* never let chatter break the panel */ }
    }

    /** Push a flashy "knowledge injected" card into the chat sidebar and
     *  persist a tiny markdown breadcrumb to history so it survives reloads
     *  even if the sidebar wasn't open at injection time. */
    public broadcastInjectCard(title: string, relPath: string) {
        // Persistent breadcrumb in chat history (compact markdown)
        const breadcrumb = '> 🧠 **새 지식 주입됨** · `' + title + '.md`\n> 📁 `' + relPath + '`\n> ✦ I know ' + title + '.';
        this._chatHistory.push({ role: 'assistant', content: breadcrumb });
        this._displayMessages.push({ role: 'ai', text: breadcrumb });
        this._saveHistory();
        // Live, animated card if the sidebar is mounted right now
        if (this._view) {
            this._view.webview.postMessage({ type: 'brainInject', title, relPath });
        }
    }

    /** Re-scan the brain folder and push fresh node/link data to every open
     *  graph panel. Called after brain-inject (EZER, A.U Training, etc.) so
     *  the user sees new knowledge appear immediately, plus a brief pulse
     *  on the freshly-added node. */
    public broadcastGraphRefresh(highlightTitle?: string) {
        try {
            const brainDir = _getBrainDir();
            if (!fs.existsSync(brainDir)) return;
            const graph = buildKnowledgeGraph(brainDir);
            const data = {
                nodes: graph.nodes.map(n => ({
                    id: n.id, name: n.name, folder: n.folder, tags: n.tags,
                    connections: n.incoming + n.outgoing
                })),
                links: graph.links
            };
            const msg = { type: 'graphData', data, highlightTitle: highlightTitle || null };
            if (this._thinkingPanel && this._thinkingReady) {
                this._thinkingPanel.webview.postMessage(msg);
            }
            this._externalGraphPanels.forEach(panel => {
                try { panel.webview.postMessage(msg); } catch { /* disposed */ }
            });
        } catch (e) {
            console.error('broadcastGraphRefresh failed:', e);
        }
    }

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

    // ============================================================
    // 🎬 Thinking Mode helpers
    // ============================================================
    private async _toggleThinkingMode() {
        this._thinkingMode = !this._thinkingMode;
        if (this._thinkingMode) {
            this._openThinkingPanel();
        } else {
            this._closeThinkingPanel();
        }
        if (this._view) {
            this._view.webview.postMessage({ type: 'thinkingModeState', value: this._thinkingMode });
        }
    }

    private _openThinkingPanel() {
        if (this._thinkingPanel) {
            this._thinkingPanel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        const brainDir = _getBrainDir();
        const graph = buildKnowledgeGraph(brainDir);

        const assetsRoot = vscode.Uri.file(path.join(this._ctx.extensionPath, 'assets'));
        const panel = vscode.window.createWebviewPanel(
            'connectAiThinking',
            '🎬 Thinking Mode — AI 사고 시각화',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assetsRoot] }
        );

        // Inject the same graph HTML used by showBrainNetwork — it already listens
        // for thinking events via window.message and is fully reusable.
        const forceGraphSrc = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._ctx.extensionPath, 'assets', 'force-graph.min.js'))
        ).toString();
        panel.webview.html = this._buildThinkingHtml(graph, forceGraphSrc, panel.webview.cspSource);

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'graph_ready') {
                this._thinkingReady = true;
                return;
            }
            if (msg.type === 'openFile' && typeof msg.id === 'string') {
                const safe = safeResolveInside(brainDir, msg.id);
                if (safe && fs.existsSync(safe)) {
                    const doc = await vscode.workspace.openTextDocument(safe);
                    vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
                }
            }
        });
        panel.onDidDispose(() => {
            this._thinkingPanel = undefined;
            this._thinkingReady = false;
            this._thinkingMode = false;
            if (this._view) this._view.webview.postMessage({ type: 'thinkingModeState', value: false });
        });
        this._thinkingPanel = panel;
    }

    private _closeThinkingPanel() {
        if (this._thinkingPanel) {
            this._thinkingPanel.dispose();
            this._thinkingPanel = undefined;
            this._thinkingReady = false;
        }
    }

    /** Should we emit thinking events at all? True if either:
     *  - the dedicated Thinking Mode panel is on, or
     *  - the user has a normal brain-network graph panel open and would
     *    benefit from seeing the AI's live activity on it. */
    private _shouldEmitThinking(): boolean {
        return this._thinkingMode || this._externalGraphPanels.size > 0;
    }

    private _postThinking(message: any) {
        if (this._thinkingPanel && this._thinkingReady) {
            this._thinkingPanel.webview.postMessage(message);
        }
        // Also broadcast to any externally-opened brain network panels.
        // Their webview always has the message listener attached, so we don't
        // need a per-panel "ready" handshake — best-effort send is fine.
        this._externalGraphPanels.forEach(panel => {
            try { panel.webview.postMessage(message); } catch { /* disposed */ }
        });
    }

    // ============================================================
    // 📊 Header status bar — folder + GitHub status, always visible
    // ============================================================
    private _sendCompanyState(noteToUser?: string) {
        if (!this._view) return;
        const dir = getCompanyDir();
        const exists = fs.existsSync(path.join(dir, '_shared'));
        const configured = isCompanyConfigured();
        this._view.webview.postMessage({
            type: 'corporateState',
            companyDir: dir.replace(os.homedir(), '~'),
            companyName: readCompanyName(),
            folderExists: exists,
            configured,
            note: noteToUser || ''
        });
    }

    private _sendStatusUpdate() {
        if (!this._view) return;
        const cfg = vscode.workspace.getConfiguration('connectAiLab');
        const folderPath = _isBrainDirExplicitlySet() ? _getBrainDir() : '';
        let fileCount = 0;
        if (folderPath && fs.existsSync(folderPath)) {
            try { fileCount = this._findBrainFiles(folderPath).length; } catch { /* ignore */ }
        }
        const githubUrl = cfg.get<string>('secondBrainRepo', '') || '';
        // Last-sync time computed from latest commit on the brain repo, if any
        let lastSync = '';
        if (folderPath && fs.existsSync(path.join(folderPath, '.git'))) {
            const out = gitExecSafe(['log', '-1', '--format=%cr'], folderPath);
            if (out) lastSync = out.trim();
        }
        this._view.webview.postMessage({
            type: 'statusUpdate',
            value: {
                folderPath,
                fileCount,
                githubUrl,
                lastSync,
                syncing: this._isSyncingBrain || _autoSyncRunning
            }
        });
    }

    private async _handleStatusFolderClick() {
        const isSet = _isBrainDirExplicitlySet();
        if (!isSet) {
            // Not configured yet → kick off folder selection
            await _ensureBrainDir();
            this._sendStatusUpdate();
            return;
        }
        // Configured → reveal folder in OS file explorer
        const dir = _getBrainDir();
        if (fs.existsSync(dir)) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        }
    }

    private async _handleStatusGitClick() {
        // Beginner-friendly: clicking ☁️ ALWAYS opens the URL input box, with the
        // current URL pre-filled. After save, sync runs automatically.
        // No nested menu — direct typing is the most intuitive flow.
        const cfg = vscode.workspace.getConfiguration('connectAiLab');
        const existing = cfg.get<string>('secondBrainRepo', '') || '';

        const inputUrl = await vscode.window.showInputBox({
            prompt: existing
                ? '🔗 GitHub 저장소 주소를 확인하거나 변경하세요 (Enter로 저장 + 동기화)'
                : '🔗 백업할 GitHub 저장소 주소를 붙여넣고 Enter (예: https://github.com/내이름/저장소)',
            placeHolder: 'https://github.com/사용자명/저장소이름',
            value: existing,
            ignoreFocusOut: true,
            validateInput: (val) => {
                const v = (val || '').trim();
                if (!v) return null;
                if (validateGitRemoteUrl(v)) return null;
                return '⚠️ 형식이 맞지 않아요. 예: https://github.com/내이름/저장소  또는  git@github.com:내이름/저장소.git';
            }
        });

        if (inputUrl === undefined) {
            // User pressed ESC — do nothing
            return;
        }

        const trimmed = inputUrl.trim();
        if (!trimmed) {
            // User cleared the input → ask if they want to disconnect
            const disconnect = await vscode.window.showWarningMessage(
                'GitHub 백업을 끊을까요?',
                { modal: true },
                '☁️ 끊기',
                '⛔ 취소'
            );
            if (disconnect === '☁️ 끊기') {
                await cfg.update('secondBrainRepo', '', vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('☁️ GitHub 백업 연결을 해제했어요.');
                this._sendStatusUpdate();
            }
            return;
        }

        const cleaned = validateGitRemoteUrl(trimmed) || trimmed;
        const isNew = cleaned !== existing;
        if (isNew) {
            await cfg.update('secondBrainRepo', cleaned, vscode.ConfigurationTarget.Global);
        }

        // Always sync after — fresh URL or just confirming
        await this._syncSecondBrain();
        this._sendStatusUpdate();
    }

    /** Build the same HTML that showBrainNetwork uses — kept inline for reuse. */
    private _buildThinkingHtml(graph: BrainGraph, forceGraphSrc: string, cspSource: string): string {
        const graphJson = JSON.stringify({
            nodes: graph.nodes.map(n => ({
                id: n.id, name: n.name, folder: n.folder, tags: n.tags,
                connections: n.incoming + n.outgoing
            })),
            links: graph.links
        });
        const isEmpty = graph.nodes.length === 0;
        return _RENDER_GRAPH_HTML(graphJson, isEmpty, forceGraphSrc, cspSource);
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

    /** 외부에서 프롬프트 전송 (예: 코드 선택 → 설명, EZER 주입 등).
     *  sidebar가 아직 mount 안 됐어도 history에는 항상 저장 — 다음에 사이드바를
     *  열면 자동 복원되어 보임. mount되어 있으면 즉시 webview에도 전달. */
    public injectSystemMessage(message: string) {
        this._chatHistory.push({ role: 'assistant', content: message });
        this._displayMessages.push({ role: 'ai', text: message });
        this._saveHistory();
        if (this._view) {
            this._view.webview.postMessage({ type: 'response', value: message });
        }
    }

    // Pending prompts buffered while the sidebar webview is unmounted —
    // flushed when resolveWebviewView wires up the new _view.
    private _pendingPrompts: string[] = [];
    public sendPromptFromExtension(prompt: string) {
        if (this._view) {
            this._view.show?.(true);
            // 약간의 딜레이 후 전송 (뷰가 보이기를 기다림)
            setTimeout(() => {
                this._view?.webview.postMessage({ type: 'injectPrompt', value: prompt });
            }, 300);
        } else {
            // Buffer until the sidebar opens; cap to avoid unbounded growth.
            this._pendingPrompts.push(prompt);
            if (this._pendingPrompts.length > 20) this._pendingPrompts.shift();
        }
    }
    /** Called from resolveWebviewView once _view is ready. */
    private _flushPendingPrompts() {
        if (!this._view || this._pendingPrompts.length === 0) return;
        const queue = this._pendingPrompts.slice();
        this._pendingPrompts.length = 0;
        queue.forEach((p, i) => {
            setTimeout(() => this._view?.webview.postMessage({ type: 'injectPrompt', value: p }), 400 + i * 200);
        });
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
                    if (msg.corporate) {
                        await this._handleCorporatePrompt(msg.value, msg.model);
                    } else {
                        await this._handlePrompt(msg.value, msg.model, msg.internet);
                    }
                    break;
                case 'promptWithFile':
                    await this._handlePromptWithFile(msg.value, msg.model, msg.files, msg.internet);
                    break;
                case 'corporateInit':
                    try {
                        const dir = getCompanyDir();
                        const exists = fs.existsSync(path.join(dir, '_shared'));
                        const configured = isCompanyConfigured();
                        if (this._view) {
                            this._view.webview.postMessage({
                                type: 'corporateReady',
                                agents: AGENT_ORDER.map(id => ({
                                    id,
                                    name: AGENTS[id].name,
                                    role: AGENTS[id].role,
                                    emoji: AGENTS[id].emoji,
                                    color: AGENTS[id].color
                                })),
                                companyDir: dir.replace(os.homedir(), '~'),
                                companyName: readCompanyName(),
                                folderExists: exists,
                                configured
                            });
                        }
                    } catch (e: any) {
                        if (this._view) this._view.webview.postMessage({ type: 'error', value: `⚠️ 회사 폴더 초기화 실패: ${e.message}` });
                    }
                    break;
                case 'openCompanyFolder':
                    try {
                        const dir = ensureCompanyStructure();
                        const sub = msg.sub || '';
                        const target = sub ? path.join(dir, sub) : dir;
                        vscode.env.openExternal(vscode.Uri.file(target));
                    } catch { /* ignore */ }
                    break;
                case 'companySetup': {
                    // msg.choice: 'default' | 'pick' | 'import'
                    const choice = msg.choice as string;
                    try {
                        if (choice === 'default') {
                            // ~/.connect-ai-brain (brain dir == company dir)
                            await setCompanyDir('');
                            ensureCompanyStructure();
                            this._sendCompanyState('회사 폴더가 두뇌 폴더 안에 만들어졌어요.');
                        } else if (choice === 'pick') {
                            const picked = await vscode.window.showOpenDialog({
                                canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                                openLabel: '두뇌+회사 폴더로 사용할 위치 선택',
                                title: '두뇌+회사 폴더 선택 (이 폴더 안에 _shared, _agents 등이 만들어집니다)'
                            });
                            if (picked && picked[0]) {
                                const target = picked[0].fsPath;
                                fs.mkdirSync(target, { recursive: true });
                                await setCompanyDir(target);
                                ensureCompanyStructure();
                                this._sendCompanyState(`두뇌+회사 폴더가 ${target} 에 설정되었어요.`);
                            } else {
                                this._sendCompanyState('취소했어요.');
                            }
                        } else if (choice === 'import') {
                            const url = await vscode.window.showInputBox({
                                prompt: '기존 회사 폴더의 GitHub URL (예: https://github.com/me/my-company-brain.git)',
                                placeHolder: 'https://github.com/...',
                                validateInput: (v) => {
                                    if (!v || !v.trim()) return undefined;
                                    return validateGitRemoteUrl(v) ? undefined : '⚠️ 유효한 GitHub URL이 아닙니다';
                                }
                            });
                            if (url) {
                                const targetParent = path.join(os.homedir(), '.connect-ai-brain-imported');
                                fs.mkdirSync(targetParent, { recursive: true });
                                const targetName = path.basename(url, '.git');
                                const target = path.join(targetParent, targetName);
                                if (fs.existsSync(target)) {
                                    this._view?.webview.postMessage({ type: 'error', value: `⚠️ 이미 존재하는 폴더: ${target}\n다른 이름으로 다시 시도하거나 폴더를 먼저 정리해주세요.` });
                                } else {
                                    const r = gitRun(['clone', url, target], targetParent, 60000);
                                    if (r.status === 0) {
                                        // import한 위치가 Company 자체이거나 상위인지 확인
                                        const candidate = fs.existsSync(path.join(target, '_shared')) ? target : path.join(target, 'Company');
                                        await setCompanyDir(candidate);
                                        ensureCompanyStructure();
                                        this._sendCompanyState(`✅ 가져오기 완료: ${candidate}`);
                                    } else {
                                        this._view?.webview.postMessage({ type: 'error', value: `⚠️ git clone 실패: ${r.stderr || r.error?.message || 'unknown'}` });
                                    }
                                }
                            } else {
                                this._sendCompanyState('취소했어요.');
                            }
                        }
                    } catch (e: any) {
                        this._view?.webview.postMessage({ type: 'error', value: `⚠️ 회사 설정 실패: ${e.message}` });
                    }
                    break;
                }
                case 'companyInterview': {
                    // msg.answers: { name, oneLiner, goal }
                    try {
                        ensureCompanyStructure();
                        const dir = getCompanyDir();
                        const a = msg.answers || {};
                        const name = (a.name || '').trim();
                        const oneLiner = (a.oneLiner || '').trim();
                        const goal = (a.goal || '').trim();
                        const idPath = path.join(dir, '_shared', 'identity.md');
                        const goalsPath = path.join(dir, '_shared', 'goals.md');
                        fs.writeFileSync(idPath,
`# 🏢 회사 정체성

- **회사 이름:** ${name || '(아직 미설정)'}
- **한 줄 소개:** ${oneLiner || '(아직 미설정)'}
- **타깃 청중:** _자가학습이 채울 예정_
- **브랜드 톤:** _자가학습이 채울 예정_
- **금기:** _자가학습이 채울 예정_

> 이 파일은 사용자가 직접 편집하거나, 작업하면서 자가학습으로 채워집니다.
`);
                        fs.writeFileSync(goalsPath,
`# 🎯 공동 목표

## 올해 핵심 목표
- [ ] ${goal || '(아직 미설정 — 작업하면서 추가)'}

## 1개월 내 단기 목표
_자가학습이 채울 예정_

> 모든 에이전트가 매번 이 파일을 읽고 일합니다.
`);
                        this._sendCompanyState(`✅ "${name}" 설정 완료. 명령을 내려보세요.`);
                    } catch (e: any) {
                        this._view?.webview.postMessage({ type: 'error', value: `⚠️ 인터뷰 저장 실패: ${e.message}` });
                    }
                    break;
                }
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
                case 'openOffice':
                    vscode.commands.executeCommand('connect-ai-lab.openOffice');
                    break;
                case 'toggleOffice':
                    if (OfficePanel.current) {
                        OfficePanel.current.dispose();
                    } else {
                        vscode.commands.executeCommand('connect-ai-lab.openOffice');
                    }
                    break;
                case 'closeOffice':
                    if (OfficePanel.current) OfficePanel.current.dispose();
                    break;
                case 'toggleThinking':
                    await this._toggleThinkingMode();
                    break;
                case 'requestStatus':
                    this._sendStatusUpdate();
                    break;
                case 'statusFolderClick':
                    await this._handleStatusFolderClick();
                    break;
                case 'statusGitClick':
                    await this._handleStatusGitClick();
                    break;
                case 'highlightBrainNote':
                    if (typeof msg.note === 'string') {
                        if (!this._thinkingPanel) this._openThinkingPanel();
                        // Allow the panel a moment to load before sending the highlight
                        setTimeout(() => this._postThinking({ type: 'highlight_node', note: msg.note }), 350);
                    }
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

        // Sidebar just mounted — drain any prompts that were buffered while it
        // was closed (e.g. EZER injected knowledge before the user opened it).
        this._flushPendingPrompts();
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
        this._sendStatusUpdate();
            
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
                    const res = await axios.get(`${ollamaBase}/v1/models`, { timeout: 3000 });
                    models = (res.data?.data || []).map((m: any) => m.id);
                }
            } else {
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
            { label: '☁️ 온라인 지식 공간', description: currentRepo ? `GitHub: ${repoLabel}` : 'GitHub 주소 설정', action: 'changeGithub' },
            { label: '📁 로컬 지식 공간', description: brainDir ? `폴더: ${path.basename(brainDir)} (${fileCount}개 파일)` : '폴더 위치 설정', action: 'changeFolder' },
            { label: '🔄 지금 백업', description: '온라인과 로컬 동기화', action: 'githubSync' },
            { label: '🌐 네트워크 보기', description: '지식 연결 그래프', action: 'viewGraph' },
            { label: '🗑️ 삭제', description: 'GitHub 연결 또는 로컬 폴더 분리', action: 'cleanup' },
        ];

        const pick = await vscode.window.showQuickPick(items, { placeHolder: '🧠 지식 공간 관리' });
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
                const existing = vscode.workspace.getConfiguration('connectAiLab').get<string>('secondBrainRepo', '');
                const inputUrl = await vscode.window.showInputBox({
                    prompt: '☁️ 온라인 지식 공간 — GitHub 주소 (Enter로 저장)',
                    placeHolder: '예: https://github.com/사용자명/저장소이름',
                    value: existing,
                    ignoreFocusOut: true,
                    validateInput: (val) => {
                        const v = (val || '').trim();
                        if (!v) return null;
                        if (validateGitRemoteUrl(v)) return null;
                        return '⚠️ 형식: https://github.com/사용자/저장소  또는  git@github.com:사용자/저장소.git';
                    }
                });
                if (inputUrl !== undefined && inputUrl.trim()) {
                    const cleaned = validateGitRemoteUrl(inputUrl) || inputUrl.trim();
                    await vscode.workspace.getConfiguration('connectAiLab').update('secondBrainRepo', cleaned, vscode.ConfigurationTarget.Global);
                    const saved = vscode.workspace.getConfiguration('connectAiLab').get<string>('secondBrainRepo', '');
                    vscode.window.showInformationMessage(`✅ 온라인 지식 공간 저장됨: ${saved}`);
                    this._sendStatusUpdate();
                }
                break;
            }
            case 'cleanup': {
                const cfg = vscode.workspace.getConfiguration('connectAiLab');
                const hasGit = !!(cfg.get<string>('secondBrainRepo', '') || '');
                const hasFolder = _isBrainDirExplicitlySet();

                const items: any[] = [];
                if (hasGit) items.push({ label: '☁️ 온라인 지식 공간 연결만 끊기', description: '파일은 그대로, GitHub 주소만 제거', kind: 'github' });
                if (hasFolder) items.push({ label: '📁 로컬 지식 공간 연결만 분리', description: '파일은 디스크에 그대로, 익스텐션에서만 분리', kind: 'folder' });
                if (items.length === 0) {
                    vscode.window.showInformationMessage('지울 연결이 없어요. 이미 깨끗합니다 ✨');
                    break;
                }
                items.push({ label: '⛔ 취소', kind: 'cancel' });

                const pick2 = await vscode.window.showQuickPick(items, { placeHolder: '🗑️ 무엇을 끊을까요?' });
                if (!pick2 || pick2.kind === 'cancel') break;

                if (pick2.kind === 'github') {
                    const confirm = await vscode.window.showWarningMessage(
                        '☁️ 온라인 지식 공간 연결을 끊을까요?\n\n• GitHub 저장소 주소만 제거됩니다\n• 로컬 파일과 GitHub 저장소 자체는 그대로 남아요',
                        { modal: true },
                        '☁️ 끊기',
                        '⛔ 취소'
                    );
                    if (confirm === '☁️ 끊기') {
                        await cfg.update('secondBrainRepo', '', vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('☁️ 온라인 지식 공간 연결 해제됨.');
                        this._sendStatusUpdate();
                    }
                } else if (pick2.kind === 'folder') {
                    const confirm = await vscode.window.showWarningMessage(
                        '📁 로컬 지식 공간 연결을 분리할까요?\n\n• 익스텐션이 더 이상 이 폴더를 참조하지 않습니다\n• 디스크의 파일은 그대로 남아요 (수동 삭제 안 함)',
                        { modal: true },
                        '📁 분리',
                        '⛔ 취소'
                    );
                    if (confirm === '📁 분리') {
                        await cfg.update('localBrainPath', '', vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('📁 로컬 지식 공간 연결 분리됨.');
                        this._sendStatusUpdate();
                    }
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
                prompt: '🧠 GitHub 저장소 주소를 입력하세요 (Enter로 저장)',
                placeHolder: '예: https://github.com/사용자명/저장소이름',
                ignoreFocusOut: true,
                validateInput: (val) => {
                    const v = (val || '').trim();
                    if (!v) return null;
                    if (validateGitRemoteUrl(v)) return null;
                    return '⚠️ 형식: https://github.com/사용자/저장소  또는  git@github.com:사용자/저장소.git';
                }
            });
            if (!inputUrl || !inputUrl.trim()) { return; }

            const cleaned = validateGitRemoteUrl(inputUrl) || inputUrl.trim();
            await vscode.workspace.getConfiguration('connectAiLab').update('secondBrainRepo', cleaned, vscode.ConfigurationTarget.Global);
            secondBrainRepo = cleaned;
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

            // 인증은 시스템 git에 맡깁니다 (osxkeychain / gh CLI / SSH 키 등).
            // VS Code OAuth 강제 호출은 더 헷갈리게 만들었기 때문에 제거.

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
                            '🤔 내 PC와 GitHub이 서로 다르게 수정됐어요.\n어떤 걸 살릴까요?',
                            { modal: true },
                            '🤝 둘 다 합치기 (추천)',
                            '💻 내 PC 내용으로 덮어쓰기',
                            '☁️ GitHub 내용으로 덮어쓰기'
                        );
                        if (!choice) {
                            this._view.webview.postMessage({ type: 'response', value: '⏸️ 동기화 취소했어요. 내 PC 파일은 그대로 안전합니다.' });
                            return;
                        }
                        // 선택 적용 — 자동 병합 실패 시 즉시 재선택 다이얼로그를 띄워 사용자를 메뉴로 돌려보내지 않음
                        let resolved = false;
                        let activeChoice: string = choice;
                        for (let attempt = 0; attempt < 3 && !resolved; attempt++) {
                            if (activeChoice.startsWith('🤝')) {
                                // We already fetched at step 3 above — use git merge directly to avoid the
                                // git 2.27+ "divergent branches" hint that `git pull` (without --rebase / --ff-only) emits.
                                const mergeRes = gitRun(['merge', '--no-edit', '--allow-unrelated-histories', `origin/${remoteBranch}`], brainDir, 30000);
                                if (mergeRes.status === 0) {
                                    resolved = true;
                                    break;
                                }
                                // 실패 → 머지 상태 정리 후 사용자에게 다른 방법을 즉시 제안
                                gitExecSafe(['merge', '--abort'], brainDir);
                                const conflicted = gitExecSafe(['diff', '--name-only', '--diff-filter=U'], brainDir)?.trim();
                                const detailMsg = conflicted
                                    ? `🤝 자동으로 못 합쳤어요. 같은 줄이 양쪽에서 다르게 수정됐거든요.\n\n충돌 파일:\n${conflicted}\n\n어떻게 할까요?`
                                    : '🤝 자동으로 못 합쳤어요. 어떻게 할까요?';
                                const next = await vscode.window.showWarningMessage(
                                    detailMsg,
                                    { modal: true },
                                    '💻 내 PC 내용으로 덮어쓰기',
                                    '☁️ GitHub 내용으로 덮어쓰기',
                                    '🛠️ 폴더 열어서 직접 고치기'
                                );
                                if (!next) {
                                    this._view.webview.postMessage({ type: 'response', value: '⏸️ 동기화 취소했어요. 내 PC 파일은 그대로 안전합니다.' });
                                    return;
                                }
                                if (next.startsWith('🛠️')) {
                                    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(brainDir));
                                    this._view.webview.postMessage({ type: 'response', value: '🛠️ 폴더를 열었어요. 파일을 직접 수정한 뒤, 메뉴에서 다시 동기화를 눌러주세요.' });
                                    return;
                                }
                                activeChoice = next;
                                continue;
                            }
                            if (activeChoice.startsWith('💻') || activeChoice.startsWith('💪')) {
                                // git merge with -s recursive -X ours = "merge, but on conflicts prefer my (local) side"
                                const mres = gitRun(['merge', '--no-edit', '--allow-unrelated-histories', '-s', 'recursive', '-X', 'ours', `origin/${remoteBranch}`], brainDir, 30000);
                                if (mres.status !== 0) throw new Error(classifyGitError(mres.stderr).message);
                                resolved = true;
                                break;
                            }
                            // ☁️ GitHub 내용으로 덮어쓰기
                            const fres = gitRun(['fetch', 'origin', remoteBranch], brainDir, 30000);
                            if (fres.status !== 0) throw new Error(classifyGitError(fres.stderr).message);
                            gitExec(['reset', '--hard', `origin/${remoteBranch}`], brainDir, 15000);
                            resolved = true;
                            break;
                        }
                        if (!resolved) {
                            throw new Error('합치기를 끝내지 못했어요. 폴더를 직접 열어서 수정해주세요.');
                        }
                    }
                }
            }

            // 5. push — 시스템 git 자격증명 그대로 사용 (osxkeychain / gh CLI / SSH 키)
            const pushRes = gitRun(['push', '-u', 'origin', remoteBranch], brainDir, 60000);
            if (pushRes.status !== 0) {
                const err = classifyGitError(pushRes.stderr);
                if (err.kind === 'rejected') {
                    // 충돌이 다시 발생한 경우 — force-push는 사용자 명시적 동의 후에만
                    const force = await vscode.window.showWarningMessage(
                        '☁️ GitHub에 더 새로운 내용이 있어요.\n\n그래도 내 PC 내용으로 덮어쓸까요?\n(주의: GitHub의 새 내용은 영구 삭제됩니다)',
                        { modal: true },
                        '⛔ 그만두기 (안전)',
                        '⚠️ 그래도 덮어쓰기'
                    );
                    if (force === '⚠️ 그래도 덮어쓰기') {
                        const forceRes = gitRun(['push', '-u', 'origin', remoteBranch, '--force-with-lease'], brainDir, 60000);
                        if (forceRes.status !== 0) {
                            throw new Error(classifyGitError(forceRes.stderr).message);
                        }
                    } else {
                        throw new Error('덮어쓰기를 그만두었어요. 내 PC 파일은 그대로 안전합니다.');
                    }
                } else {
                    throw new Error(err.message);
                }
            }

            // 연동 완료 후 자동으로 지식 모드 ON
            this._brainEnabled = true;
            this._ctx.globalState.update('brainEnabled', true);

            vscode.window.showInformationMessage('✅ GitHub 동기화 완료!');
            this._view.webview.postMessage({ type: 'response', value: `✅ **동기화가 끝났어요!** (브랜치: \`${remoteBranch}\`)\n\n내 PC와 GitHub이 이제 완전히 똑같은 상태예요.\n\n앞으로 AI가 답변할 때 이 지식들을 참고합니다. (지식 모드: 🟢 ON)` });
            this._sendStatusUpdate();
        } catch (error: any) {
            const userMsg = error?.message || '알 수 없는 문제가 생겼어요';
            vscode.window.showErrorMessage(`동기화 실패: ${userMsg}`);
            this._view.webview.postMessage({ type: 'error', value: `⚠️ ${userMsg}` });
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
            this._abortController = new AbortController();

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
                    options: { num_ctx: 8192, num_predict: 2048, temperature: this._temperature, top_p: this._topP, top_k: this._topK }
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

            // 스트리밍: 웹뷰에 'streamStart' 로 빈 메시지 생성 후 'streamChunk'로 실시간 업데이트
            this._view.webview.postMessage({ type: 'streamStart' });
            this._lastPrompt = prompt;
            this._lastModel = modelName;
            this._abortController = new AbortController();

            const streamBody = {
                model: modelName || defaultModel,
                messages: reqMessages,
                stream: true,
                ...(isLMStudio
                    ? { max_tokens: 4096, temperature: this._temperature, top_p: this._topP }
                    : { options: { num_ctx: 8192, num_predict: 2048, temperature: this._temperature, top_p: this._topP, top_k: this._topK } }),
            };

            // 🎬 Thinking Mode: notify graph panel that a session is starting
            if (this._shouldEmitThinking()) {
                this._postThinking({ type: 'thinking_start', prompt });
                this._postThinking({
                    type: 'context_done',
                    workspace: !!workspaceCtx,
                    brainCount: this._brainEnabled ? (brainCtx ? brainCtx.split('📄').length - 1 : 0) : 0,
                    web: !!internetEnabled
                });
            }

            const response = await axios.post(apiUrl, streamBody, {
                timeout,
                responseType: 'stream',
                signal: this._abortController.signal
            });

            // 🎬 Track which brain notes the AI mentions DURING streaming
            const seenBrainReads = new Set<string>();
            const detectBrainReadsLive = () => {
                if (!this._shouldEmitThinking()) return;
                const matches = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)];
                for (const m of matches) {
                    const note = m[1].trim();
                    if (note && !seenBrainReads.has(note)) {
                        seenBrainReads.add(note);
                        this._postThinking({ type: 'brain_read', note });
                    }
                }
            };
            // 🎬 Emit answer_start exactly once when the first real answer token arrives.
            // Without this, the thinking panel sticks at "🧠 파일명 검색 중..." forever.
            let answerStartFired = false;
            const fireAnswerStart = () => {
                if (this._shouldEmitThinking() && !answerStartFired) {
                    answerStartFired = true;
                    this._postThinking({ type: 'answer_start' });
                }
            };

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
                                // 🎬 Live thinking detection — fire as soon as a tag is closed
                                detectBrainReadsLive();
                                if (this._shouldEmitThinking()) {
                                    fireAnswerStart();
                                    this._postThinking({ type: 'answer_chunk', text: token });
                                }
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
                        : { options: { num_ctx: 8192, num_predict: 2048, temperature: this._temperature, top_p: this._topP, top_k: this._topK } }),
                }, { timeout, responseType: 'stream', signal: this._abortController?.signal });

                aiMessage = cleanedResponse + uiFeedbackStr;

                // 🎬 Brain phase done, real answer phase begins on the follow-up stream
                if (this._shouldEmitThinking()) {
                    this._postThinking({ type: 'answer_start' });
                }

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
                                    if (this._shouldEmitThinking()) {
                                        this._postThinking({ type: 'answer_chunk', text: token });
                                    }
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

            // 📚 Citation badges + 🎬 final source highlight
            const allBrainReads = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)]
                .map(m => m[1].trim()).filter(s => s.length > 0);
            const uniqueSources = [...new Set(allBrainReads)];
            if (uniqueSources.length > 0) {
                this._view.webview.postMessage({ type: 'attachCitations', sources: uniqueSources });
            }
            if (this._shouldEmitThinking()) {
                this._postThinking({ type: 'answer_complete', sources: uniqueSources });
            }

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
    // 1인 기업 모드 — Multi-Agent Orchestration
    // --------------------------------------------------------
    // CEO 에이전트가 사용자 한 줄 명령을 받아 작업을 분해하고,
    // 전문 에이전트들에게 순차로 일을 분배합니다. 각 에이전트는
    // 공동 목표·정체성·자기 메모리를 매번 읽고 작업합니다.
    // --------------------------------------------------------
    private async _handleCorporatePrompt(prompt: string, modelName: string) {
        if (!this._view && this._corporateBroadcastTargets.size === 0) return;
        const post = (m: any) => this._broadcastCorporate(m);
        // Single abort controller drives every LLM call in this session — sidebar
        // stop button calls _abortController.abort() which propagates through.
        this._abortController = new AbortController();
        const isAborted = () => !!this._abortController?.signal.aborted;
        try {
            ensureCompanyStructure();
            const sessionDir = makeSessionDir();
            const sessionDisplay = sessionDir.replace(os.homedir(), '~');

            this._displayMessages.push({ text: prompt, role: 'user' });

            // Phase 1: log the user command at the top of every session
            appendConversationLog({ speaker: '사용자', emoji: '👤', body: prompt });

            // 1) CEO에게 작업 분해 요청 (silent — UI에는 카드 펄스만)
            // Phase 2: inject recent conversation history into CEO context so
            // planning is aware of what the company has been doing.
            post({ type: 'agentStart', agent: 'ceo', task: '작업 분해' });
            let planRaw = '';
            try {
                planRaw = await this._callAgentLLM(
                    `${CEO_PLANNER_PROMPT}\n${readAgentSharedContext('ceo')}${readRecentConversations(2000)}`,
                    `[사용자 명령]\n${prompt}`,
                    modelName,
                    'ceo',
                    false
                );
            } catch (e: any) {
                post({ type: 'agentEnd', agent: 'ceo' });
                // Pull server-side error detail out of the axios stream response so
                // 500s don't surface as the bare "Request failed with status code 500".
                let detail = '';
                try {
                    if (e?.response?.data?.on) {
                        const buf = await new Promise<string>((resolve) => {
                            let acc = '';
                            e.response.data.on('data', (c: Buffer) => { acc += c.toString(); });
                            e.response.data.on('end', () => resolve(acc));
                            e.response.data.on('error', () => resolve(acc));
                        });
                        try { detail = JSON.parse(buf).error?.message || JSON.parse(buf).error || buf.slice(0, 300); }
                        catch { detail = buf.slice(0, 300); }
                    } else if (e?.response?.data) {
                        detail = typeof e.response.data === 'string' ? e.response.data.slice(0, 300) : JSON.stringify(e.response.data).slice(0, 300);
                    }
                } catch { /* ignore */ }
                let hint = '';
                if (/context length|context_length|num_ctx|maximum context/i.test(detail)) {
                    hint = '\n💡 컨텍스트 초과 — 더 큰 모델로 바꾸거나 회사 폴더의 _shared/decisions.md / _agents/ceo/memory.md를 줄여주세요.';
                } else if (/out of memory|cuda|allocation/i.test(detail)) {
                    hint = '\n💡 메모리 부족 — 작은 모델 사용 또는 다른 무거운 앱 종료 후 재시도.';
                } else if (e?.code === 'ECONNREFUSED') {
                    hint = '\n💡 LLM 서버에 연결 못함 — Ollama/LM Studio가 켜져 있는지 확인.';
                }
                post({ type: 'error', value: `⚠️ CEO 호출 실패: ${e.message}${detail ? '\n원인: ' + detail : ''}${hint}` });
                return;
            }
            post({ type: 'agentEnd', agent: 'ceo' });

            // 2) JSON 파싱 (관대하게)
            let plan: { brief: string; tasks: { agent: string; task: string }[] } | null = null;
            try {
                const m = planRaw.match(/\{[\s\S]*\}/);
                plan = JSON.parse(m ? m[0] : planRaw);
            } catch {
                plan = null;
            }
            if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
                post({
                    type: 'error',
                    value: `⚠️ CEO가 작업 분배 계획(JSON)을 생성하지 못했어요. 다시 시도해주세요.\n\n원본 응답:\n${planRaw.slice(0, 400)}`
                });
                return;
            }
            // 유효한 에이전트만 필터 — 모델이 케이스/공백/한글명을 섞어 보낼 수 있으니
            // 관대하게 매칭. 영문 id 정확매칭 → 소문자/trim → 한글이름·영문이름 부분일치 순.
            const idLookup = new Map<string, string>();
            for (const id of SPECIALIST_IDS) {
                idLookup.set(id, id);
                idLookup.set(id.toLowerCase(), id);
                const a = AGENTS[id];
                if (a) {
                    idLookup.set(a.name.toLowerCase(), id);
                    idLookup.set(a.name, id);
                }
            }
            const koreanAlias: Record<string, string> = {
                '유튜브': 'youtube', '인스타': 'instagram', '인스타그램': 'instagram',
                '디자이너': 'designer', '디자인': 'designer',
                '개발자': 'developer', '개발': 'developer',
                '비즈니스': 'business', '경영': 'business',
                '비서': 'secretary', '비서관': 'secretary',
                '편집자': 'editor', '편집': 'editor',
                '작가': 'writer', '카피라이터': 'writer',
                '리서처': 'researcher', '연구원': 'researcher', '리서치': 'researcher',
            };
            const originalTasks = [...plan.tasks];
            plan.tasks = plan.tasks
                .map(t => {
                    const raw = String(t.agent || '').trim();
                    const direct = idLookup.get(raw) || idLookup.get(raw.toLowerCase());
                    if (direct) return { ...t, agent: direct };
                    if (koreanAlias[raw]) return { ...t, agent: koreanAlias[raw] };
                    // partial: any specialist id that appears as substring
                    const lower = raw.toLowerCase();
                    const hit = SPECIALIST_IDS.find(id => lower.includes(id));
                    if (hit) return { ...t, agent: hit };
                    return null;
                })
                .filter((t): t is { agent: string; task: string } => !!t);
            if (plan.tasks.length === 0) {
                const wantedIds = originalTasks.map(t => `"${t.agent}"`).join(', ');
                post({
                    type: 'error',
                    value: `⚠️ CEO가 호출한 에이전트(${wantedIds || '없음'})가 우리 팀에 없어요.\n사용 가능한 id: ${SPECIALIST_IDS.join(', ')}\n\nCEO 원본 응답 일부:\n${(planRaw || '').slice(0, 300)}`
                });
                return;
            }

            // brief 저장
            try {
                fs.writeFileSync(
                    path.join(sessionDir, '_brief.md'),
                    `# 📋 작업 브리프\n\n**원 명령:** ${prompt}\n\n## 요약\n${plan.brief}\n\n## 분배\n${plan.tasks.map(t => `- **${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}**: ${t.task}`).join('\n')}\n`
                );
            } catch { /* ignore */ }

            // 3) 시네마틱 분배 알림
            post({
                type: 'agentDispatch',
                brief: plan.brief,
                tasks: plan.tasks.map(t => ({ agent: t.agent, task: t.task })),
                userPrompt: prompt
            });

            // Phase 1: log CEO's brief + assignment
            appendConversationLog({
                speaker: 'CEO', emoji: '🧭', section: '작업 분배',
                body: `${plan.brief}\n\n**할당:**\n${plan.tasks.map(t => `- ${AGENTS[t.agent]?.emoji || '🤖'} **${AGENTS[t.agent]?.name || t.agent}**: ${t.task}`).join('\n')}`,
            });

            // 4) 각 specialist 순차 호출
            const outputs: Record<string, string> = {};
            for (const t of plan.tasks) {
                if (isAborted()) {
                    post({ type: 'agentEnd', agent: t.agent });
                    break;
                }
                const a = AGENTS[t.agent];
                if (!a) continue;
                post({ type: 'agentStart', agent: t.agent, task: t.task });

                // 이전 에이전트들의 산출물을 동료의 작업으로 함께 제공
                const peerCtx = Object.keys(outputs).length > 0
                    ? `\n\n[같은 세션의 동료 에이전트 산출물]\n${Object.entries(outputs).map(([k, v]) => `\n### ${AGENTS[k]?.emoji} ${AGENTS[k]?.name}\n${v.slice(0, 1500)}`).join('\n')}`
                    : '';

                const sysPrompt = `${buildSpecialistPrompt(t.agent)}${readAgentSharedContext(t.agent)}${peerCtx}`;
                const userMsg = `[CEO의 지시]\n${t.task}\n\n[원 사용자 명령 참고]\n${prompt}`;

                let out = '';
                try {
                    out = await this._callAgentLLM(sysPrompt, userMsg, modelName, t.agent, true);
                } catch (e: any) {
                    if (isAborted()) {
                        post({ type: 'agentEnd', agent: t.agent });
                        post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                        return;
                    }
                    out = `⚠️ ${a.name} 에이전트 호출 실패: ${e.message}`;
                }
                outputs[t.agent] = out;
                try {
                    fs.writeFileSync(
                        path.join(sessionDir, `${t.agent}.md`),
                        `# ${a.emoji} ${a.name} — ${t.task}\n\n${out}\n`
                    );
                } catch { /* ignore */ }
                // 개인 메모리에 한 줄 누적
                appendAgentMemory(t.agent, `${t.task} → 산출물 sessions/${path.basename(sessionDir)}/${t.agent}.md`);
                // Phase 1: log this agent's full output to the running transcript
                appendConversationLog({ speaker: a.name, emoji: a.emoji, section: t.task.slice(0, 60), body: out });
                post({ type: 'agentEnd', agent: t.agent });
            }

            if (isAborted()) {
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return;
            }
            // 4.5) 에이전트 간 자율 대화 (Confer) — 2명 이상일 때만
            const conferTurns: { from: string; to: string; text: string }[] = [];
            if (plan.tasks.length >= 2) {
                try {
                    const conferInput = `[원 명령]\n${prompt}\n\n[산출물 요약]\n${plan.tasks.map(t => `\n## ${AGENTS[t.agent]?.name}\n${(outputs[t.agent] || '').slice(0, 800)}`).join('\n')}`;
                    const conferRaw = await this._callAgentLLM(CONFER_PROMPT, conferInput, modelName, 'ceo', false);
                    const m = conferRaw.match(/\{[\s\S]*\}/);
                    const parsed = JSON.parse(m ? m[0] : conferRaw);
                    if (parsed && Array.isArray(parsed.turns)) {
                        const validIds = SPECIALIST_IDS;
                        for (const t of parsed.turns) {
                            if (typeof t.from === 'string' && typeof t.to === 'string' && typeof t.text === 'string'
                                && validIds.includes(t.from) && validIds.includes(t.to)
                                && t.from !== t.to && t.text.trim().length > 0) {
                                conferTurns.push({ from: t.from, to: t.to, text: t.text.trim().slice(0, 80) });
                            }
                        }
                    }
                } catch { /* confer 실패는 silent */ }

                if (conferTurns.length > 0) {
                    post({ type: 'agentConfer', turns: conferTurns });
                    // Phase 1: log all confer turns into the running transcript
                    const conferBody = conferTurns
                        .map(t => `- ${AGENTS[t.from]?.emoji || ''} **${AGENTS[t.from]?.name || t.from}** → ${AGENTS[t.to]?.emoji || ''} ${AGENTS[t.to]?.name || t.to}: ${t.text}`)
                        .join('\n');
                    appendConversationLog({ speaker: '팀 회의', emoji: '💬', section: '에이전트 간 대화', body: conferBody });
                    // 사무실 시각화가 자연스럽게 흐르도록 대기 (캐릭터 walk + bubble + return)
                    await new Promise(r => setTimeout(r, Math.min(conferTurns.length * 4500, 22000)));
                }
            }

            if (isAborted()) {
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return;
            }
            // 5) CEO 종합 보고서 (UI에는 chunk 안 흘리고 카드로만 표시)
            post({ type: 'agentStart', agent: 'ceo', task: '종합 보고서 작성' });
            const reportInput = `[원 명령]\n${prompt}\n\n[브리프]\n${plan.brief}\n\n[각 에이전트 산출물]\n${plan.tasks.map(t => `\n## ${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}\n${(outputs[t.agent] || '').slice(0, 2000)}`).join('\n')}`;
            let finalReport = '';
            try {
                finalReport = await this._callAgentLLM(
                    `${CEO_REPORT_PROMPT}\n${readAgentSharedContext('ceo')}`,
                    reportInput,
                    modelName,
                    'ceo',
                    false
                );
            } catch (e: any) {
                finalReport = `⚠️ 종합 보고서 작성 실패: ${e.message}`;
            }
            post({ type: 'agentEnd', agent: 'ceo' });

            try {
                fs.writeFileSync(path.join(sessionDir, '_report.md'), `# 📝 CEO 종합 보고서\n\n${finalReport}\n`);
            } catch { /* ignore */ }
            appendAgentMemory('ceo', `${prompt} → 보고서 sessions/${path.basename(sessionDir)}/_report.md`);
            // Phase 1: log CEO's final synthesis into the running transcript
            appendConversationLog({ speaker: 'CEO', emoji: '🧭', section: '종합 보고서', body: finalReport });

            // 5.5) 자가학습 — 결정 추출 → decisions.md에 자동 append
            const learnedDecisions: string[] = [];
            try {
                const learnInput = `[원 명령]\n${prompt}\n\n[보고서]\n${finalReport.slice(0, 2500)}\n\n[대화]\n${conferTurns.map(t => `${AGENTS[t.from]?.name} → ${AGENTS[t.to]?.name}: ${t.text}`).join('\n')}`;
                const learnRaw = await this._callAgentLLM(DECISIONS_EXTRACT_PROMPT, learnInput, modelName, 'ceo', false);
                const m = learnRaw.match(/\{[\s\S]*\}/);
                const parsed = JSON.parse(m ? m[0] : learnRaw);
                if (parsed && Array.isArray(parsed.decisions)) {
                    for (const d of parsed.decisions) {
                        if (typeof d === 'string' && d.trim().length > 0 && d.trim().length <= 80) {
                            learnedDecisions.push(d.trim());
                        }
                    }
                }
            } catch { /* silent */ }

            if (learnedDecisions.length > 0) {
                try {
                    const dir = getCompanyDir();
                    const decPath = path.join(dir, '_shared', 'decisions.md');
                    if (!fs.existsSync(decPath)) {
                        fs.writeFileSync(decPath, `# 📌 회사 의사결정 로그\n\n_자가학습이 자동 누적합니다. 잘못된 항목은 직접 삭제하세요._\n`);
                    }
                    const ts = new Date().toISOString().slice(0, 10);
                    const block = `\n## [${ts}] ${prompt.slice(0, 60)}\n${learnedDecisions.map(d => `- ${d}`).join('\n')}\n_세션: ${path.basename(sessionDir)}_\n`;
                    fs.appendFileSync(decPath, block);
                } catch { /* ignore */ }
                post({ type: 'decisionsLearned', decisions: learnedDecisions });
            }

            // 6) 종합 카드
            post({
                type: 'corporateReport',
                brief: plan.brief,
                report: finalReport,
                sessionPath: sessionDisplay,
                sessionRel: `Company/sessions/${path.basename(sessionDir)}`
            });

            // 6.5) Secretary 자동 텔레그램 보고 (토큰 있을 때만)
            const tg = readTelegramConfig();
            if (tg.token && tg.chatId) {
                const company = readCompanyName() || '1인 기업';
                const tgText = `*📱 ${company} — 일일 보고*\n\n*명령:* ${prompt.slice(0, 200)}\n\n*브리프:* ${plan.brief}\n\n*완료한 에이전트:*\n${plan.tasks.map(t => `• ${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}`).join('\n')}\n\n${finalReport.slice(0, 1500)}\n\n_세션: ${path.basename(sessionDir)}_`;
                sendTelegramReport(tgText).then(ok => {
                    if (ok) {
                        post({ type: 'telegramSent', agent: 'secretary' });
                    }
                }).catch(() => { /* silent */ });
            }

            // 7) 디스플레이 히스토리 (간략)
            this._displayMessages.push({
                text: `**[1인 기업 모드]** ${plan.brief}\n\n${finalReport}\n\n_📁 저장: ${sessionDisplay}_`,
                role: 'ai'
            });
            this._saveHistory();

            // 8) 자율 git 백업 (기존 brain auto-sync 재사용)
            const brainDir = path.join(os.homedir(), '.connect-ai-brain');
            _safeGitAutoSync(brainDir, `chore(corporate): session ${path.basename(sessionDir)}`, this).catch(() => { /* silent */ });
        } catch (error: any) {
            if (isAborted()) {
                this._broadcastCorporate({ type: 'error', value: '🛑 사용자가 중단했어요.' });
            } else {
                this._broadcastCorporate({ type: 'error', value: `⚠️ 1인 기업 모드 오류: ${error.message}` });
            }
        } finally {
            this._abortController = undefined;
        }
    }

    // 단일 에이전트 LLM 호출. broadcast=true이면 토큰을 webview로 스트리밍.
    private async _callAgentLLM(
        systemPrompt: string,
        userMsg: string,
        modelName: string,
        agentId: string,
        broadcast: boolean
    ): Promise<string> {
        const { ollamaBase, defaultModel, timeout } = getConfig();
        let isLMStudio = ollamaBase.includes('1234') || ollamaBase.includes('v1');
        let apiUrl = isLMStudio ? `${ollamaBase}/v1/chat/completions` : `${ollamaBase}/api/chat`;
        if (!isLMStudio) {
            try { await axios.get(`${ollamaBase}/api/tags`, { timeout: 1000 }); }
            catch { apiUrl = 'http://127.0.0.1:1234/v1/chat/completions'; isLMStudio = true; }
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg }
        ];

        let result = '';
        const broadcast_fn = (chunk: string) => this._broadcastCorporate({ type: 'agentChunk', agent: agentId, value: chunk });

        const signal = this._abortController?.signal;

        if (isLMStudio) {
            const body = {
                model: modelName || defaultModel,
                messages,
                stream: true,
                max_tokens: 4096,
                temperature: this._temperature,
                top_p: this._topP
            };
            const response = await axios.post(apiUrl, body, { timeout, responseType: 'stream', signal });
            await new Promise<void>((resolve, reject) => {
                const stream = response.data;
                let buffer = '';
                const onAbort = () => { try { stream.destroy?.(); } catch {} reject(new Error('aborted')); };
                if (signal) signal.addEventListener('abort', onAbort, { once: true });
                stream.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    if (buffer.length > MAX_STREAM_BUFFER) buffer = buffer.slice(-MAX_STREAM_BUFFER);
                    const lines = buffer.split('\n'); buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.trim() || line.trim() === 'data: [DONE]') continue;
                        try {
                            const raw = line.startsWith('data: ') ? line.slice(6) : line;
                            const json = JSON.parse(raw);
                            const token = json.choices?.[0]?.delta?.content || '';
                            if (token) {
                                result += token;
                                if (broadcast) broadcast_fn(token);
                            }
                        } catch { /* skip */ }
                    }
                });
                stream.on('end', () => resolve());
                stream.on('error', (err: any) => reject(err));
            });
        } else {
            const body: any = {
                model: modelName || defaultModel,
                messages,
                stream: true,
                options: { num_ctx: 8192, num_predict: 2048, temperature: this._temperature, top_p: this._topP, top_k: this._topK }
            };
            const response = await axios.post(apiUrl, body, { timeout, responseType: 'stream', signal });
            await new Promise<void>((resolve, reject) => {
                const stream = response.data;
                let buffer = '';
                const onAbort = () => { try { stream.destroy?.(); } catch {} reject(new Error('aborted')); };
                if (signal) signal.addEventListener('abort', onAbort, { once: true });
                stream.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    if (buffer.length > MAX_STREAM_BUFFER) buffer = buffer.slice(-MAX_STREAM_BUFFER);
                    const lines = buffer.split('\n'); buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const json = JSON.parse(line);
                            const token = json.message?.content || '';
                            if (token) {
                                result += token;
                                if (broadcast) broadcast_fn(token);
                            }
                        } catch { /* skip */ }
                    }
                });
                stream.on('end', () => resolve());
                stream.on('error', (err: any) => reject(err));
            });
        }
        return result;
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

        // ACTION 6: Run commands — capture output so AI can see results
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
            if (!cmd) continue;

            // Live-stream the output to the chat so the user sees progress in real time
            const headerMsg = `\n\n\`\`\`bash\n$ ${cmd}\n`;
            this._view?.webview.postMessage({ type: 'streamChunk', value: headerMsg });

            try {
                const result = await runCommandCaptured(cmd, rootPath, (chunk) => {
                    this._view?.webview.postMessage({ type: 'streamChunk', value: chunk });
                });
                this._view?.webview.postMessage({ type: 'streamChunk', value: '\n```\n' });

                const status = result.timedOut
                    ? '⏱️ 60초 시간 초과로 중단됨'
                    : result.exitCode === 0
                        ? '✅ 종료 코드 0'
                        : `❌ 종료 코드 ${result.exitCode}`;
                report.push(`🖥️ 실행: \`${cmd}\` — ${status}`);

                // Inject the output back into chat history so the AI can continue with context
                // (e.g., "I see npm install failed, let me try yarn instead")
                this._chatHistory.push({
                    role: 'user',
                    content: `[시스템: run_command 결과]\n명령: ${cmd}\n종료 코드: ${result.exitCode}${result.timedOut ? ' (시간 초과)' : ''}\n출력:\n\`\`\`\n${result.output}\n\`\`\``
                });
            } catch (err: any) {
                report.push(`❌ 명령 실패: \`${cmd}\` — ${err.message}`);
                this._view?.webview.postMessage({ type: 'streamChunk', value: `\n[실행 오류] ${err.message}\n\`\`\`\n` });
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
/* Brain injection card — fired on /api/brain-inject */
.inject-card{padding:0}
.inject-card .inject-banner{position:relative;overflow:hidden;background:linear-gradient(135deg,rgba(93,224,230,.16),rgba(93,224,230,.04) 60%,rgba(255,178,102,.08));border:1px solid rgba(93,224,230,.4);border-radius:14px;padding:16px 20px;box-shadow:0 8px 32px rgba(0,0,0,.4),0 0 28px rgba(93,224,230,.18);animation:injectIn .55s cubic-bezier(.16,1,.3,1)}
@keyframes injectIn{from{opacity:0;transform:translateY(10px) scale(.98);box-shadow:0 0 60px rgba(93,224,230,.5)}to{opacity:1;transform:translateY(0) scale(1);box-shadow:0 8px 32px rgba(0,0,0,.4),0 0 28px rgba(93,224,230,.18)}}
.inject-card .inject-sweep{position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(93,224,230,.18),transparent);animation:injectSweep 1.5s ease-in-out;pointer-events:none}
@keyframes injectSweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.inject-card .inject-header{font-family:'SF Mono',monospace;font-size:10px;letter-spacing:2.5px;color:#5DE0E6;margin-bottom:10px;text-shadow:0 0 10px rgba(93,224,230,.5);position:relative;z-index:1}
.inject-card .inject-bar{height:3px;background:rgba(93,224,230,.12);border-radius:2px;overflow:hidden;margin-bottom:14px;position:relative;z-index:1}
.inject-card .inject-bar-fill{height:100%;background:linear-gradient(90deg,#5DE0E6,#FFB266);border-radius:2px;transform-origin:left;animation:injectFill 1.4s cubic-bezier(.16,1,.3,1)}
@keyframes injectFill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.inject-card .inject-title{font-size:15px;font-weight:700;color:#e8e9ee;margin-bottom:3px;position:relative;z-index:1}
.inject-card .inject-path{font-family:'SF Mono',monospace;font-size:11px;color:#7c7f8a;margin-bottom:12px;position:relative;z-index:1;word-break:break-all}
.inject-card .inject-quote{font-size:13px;color:#5DE0E6;font-weight:600;letter-spacing:.3px;position:relative;z-index:1;display:flex;align-items:center;gap:6px}
.inject-card .inject-quote::before{content:'';width:14px;height:1px;background:linear-gradient(90deg,#5DE0E6,transparent);flex-shrink:0}
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
.ag-badge{display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,rgba(66,133,244,.15),rgba(0,255,102,.1));border:1px solid rgba(66,133,244,.35);color:#4285F4;padding:4px 12px;border-radius:14px;font-size:10px;font-weight:600;letter-spacing:.3px;margin-bottom:14px;text-transform:uppercase;box-shadow:0 0 16px rgba(66,133,244,.15)}
/* Header Status Bar (folder + github status, always visible) */
.status-bar{display:flex;align-items:center;gap:8px;padding:6px 14px;background:rgba(8,8,12,.85);border-bottom:1px solid var(--border);font-size:10px;color:var(--text-dim);backdrop-filter:blur(12px);flex-shrink:0;z-index:9}
.status-bar .status-item{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:8px;cursor:pointer;transition:all .2s;border:1px solid transparent}
.status-bar .status-item:hover{background:var(--surface2);color:var(--text);border-color:var(--border2)}
.status-bar .status-item.warn{color:#ffab40}
.status-bar .status-item.warn:hover{border-color:rgba(255,171,64,.3);background:rgba(255,171,64,.08)}
.status-bar .status-item.ok{color:#00cc44}
.status-bar .status-item.syncing{color:#00b7ff}
.status-bar .status-item.syncing .status-icon{animation:spin 1.4s linear infinite}
.status-bar .sep{opacity:.3}
.status-bar .ag-mini{margin-left:auto;color:#4285F4;font-size:9px;font-weight:600;letter-spacing:.4px;opacity:.7}

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

/* ============================================================
   1인 기업 모드 — Agent Board
   ============================================================ */
.agent-board{display:none;background:linear-gradient(180deg,rgba(8,10,15,.95),rgba(5,7,11,.92));border-bottom:1px solid var(--border);padding:10px 12px 12px;position:relative;z-index:8;flex-shrink:0;backdrop-filter:blur(12px)}
body.corp-on .agent-board{display:block;animation:abSlideIn .45s cubic-bezier(.16,1,.3,1)}
/* When office panel is open, hide sidebar agent-board (it's redundant with the office view) */
body.office-open .agent-board{display:none}

@keyframes abSlideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.ab-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;font-size:10px;letter-spacing:.5px}
.ab-title{font-family:'SF Mono','JetBrains Mono',monospace;color:var(--text-bright);font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:10px}
.ab-title .ab-sub{color:var(--text-dim);font-weight:400;letter-spacing:.5px;text-transform:none;margin-left:4px}
.ab-folder{font-family:'SF Mono',monospace;color:var(--text-dim);font-size:9.5px;cursor:pointer;padding:3px 8px;border-radius:6px;border:1px solid transparent;transition:all .2s}
.ab-folder:hover{color:var(--accent);border-color:var(--border2);background:var(--surface2)}
.ab-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:6px;position:relative;z-index:2}
.ab-svg{position:absolute;left:12px;right:12px;top:36px;bottom:12px;width:calc(100% - 24px);height:calc(100% - 48px);pointer-events:none;z-index:1;opacity:0;transition:opacity .3s}
body.corp-dispatching .ab-svg{opacity:1}
.ab-card{position:relative;background:var(--surface);border:1px solid var(--border2);border-radius:10px;padding:9px 6px 7px;display:flex;flex-direction:column;align-items:center;gap:3px;transition:all .35s cubic-bezier(.16,1,.3,1);overflow:hidden;backdrop-filter:blur(8px);cursor:pointer;min-height:64px}
.ab-card::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,transparent 60%,var(--ag-color,var(--accent)) 200%);opacity:0;transition:opacity .4s;pointer-events:none}
.ab-card:hover{transform:translateY(-1px);border-color:var(--ag-color,var(--accent));box-shadow:0 4px 14px var(--accent-glow)}
.ab-card.thinking::before{opacity:.18;animation:cardPulse 1.6s ease-in-out infinite}
.ab-card.working{border-color:var(--ag-color,var(--accent));box-shadow:0 0 18px var(--ag-color-glow,var(--accent-glow)),inset 0 0 12px rgba(0,0,0,.3)}
.ab-card.working::before{opacity:.2}
.ab-card.working::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0,transparent 4px,var(--ag-color,var(--accent)) 4px,var(--ag-color,var(--accent)) 4.5px);opacity:.06;animation:cardScan 2.2s linear infinite;pointer-events:none}
.ab-card.done{border-color:var(--ag-color,var(--accent));opacity:.85}
.ab-card.done::before{opacity:.08}
.ab-card.idle{opacity:.55}
@keyframes cardPulse{0%,100%{opacity:.05}50%{opacity:.25}}
@keyframes cardScan{from{background-position:0 0}to{background-position:0 -40px}}
.ab-emoji{font-size:18px;line-height:1;filter:drop-shadow(0 0 6px var(--ag-color-glow,transparent))}
.ab-card.idle .ab-emoji{filter:grayscale(.4) brightness(.8)}
.ab-name{font-family:'SF Mono','JetBrains Mono',monospace;font-size:9px;font-weight:700;color:var(--text-bright);letter-spacing:.6px;text-transform:uppercase}
.ab-status{font-family:'SF Mono',monospace;font-size:8px;color:var(--text-dim);letter-spacing:.4px;text-transform:uppercase}
.ab-card.thinking .ab-status{color:#ffab40}
.ab-card.working .ab-status{color:var(--ag-color,var(--accent))}
.ab-card.done .ab-status{color:#00cc77}
.ab-card .ab-led{position:absolute;top:6px;right:6px;width:5px;height:5px;border-radius:50%;background:var(--text-dim);opacity:.4;transition:all .3s}
.ab-card.thinking .ab-led{background:#ffab40;animation:ledBlink 1s ease-in-out infinite;box-shadow:0 0 6px #ffab40}
.ab-card.working .ab-led{background:var(--ag-color,var(--accent));animation:ledBlink .7s ease-in-out infinite;box-shadow:0 0 8px var(--ag-color,var(--accent))}
.ab-card.done .ab-led{background:#00cc77;opacity:1;box-shadow:0 0 6px #00cc77}
@keyframes ledBlink{0%,100%{opacity:1}50%{opacity:.35}}
.ab-task-toast{position:absolute;left:50%;bottom:calc(100% + 4px);transform:translateX(-50%);background:rgba(8,10,15,.96);border:1px solid var(--ag-color,var(--accent));border-radius:6px;padding:4px 8px;font-size:9.5px;color:var(--text-bright);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;font-family:'SF Mono',monospace;z-index:5;box-shadow:0 4px 14px rgba(0,0,0,.5),0 0 12px var(--ag-color-glow,var(--accent-glow));animation:toastIn .4s cubic-bezier(.16,1,.3,1)}
@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.ab-svg .ab-beam{stroke:var(--accent);stroke-width:1.5;fill:none;stroke-dasharray:4 6;opacity:.65;filter:drop-shadow(0 0 4px var(--accent))}
.ab-svg .ab-beam.dispatching{animation:beamFlow 1.2s linear}
@keyframes beamFlow{0%{stroke-dashoffset:60;opacity:0}20%{opacity:1}100%{stroke-dashoffset:0;opacity:.65}}

/* ===== Agent-tagged messages ===== */
.msg.msg-agent{position:relative}
.msg-agent .av{background:rgba(20,22,28,.85);color:var(--ag-color,var(--accent));border:1px solid var(--ag-color,var(--accent));box-shadow:0 0 10px var(--ag-color-glow,var(--accent-glow))}
.msg-agent .ag-tag{font-family:'SF Mono','JetBrains Mono',monospace;font-size:9.5px;font-weight:700;color:var(--ag-color,var(--accent));letter-spacing:1px;text-transform:uppercase;padding:1px 7px;border:1px solid var(--ag-color,var(--accent));border-radius:5px;background:rgba(0,0,0,.3);margin-left:2px}
.msg-agent .ag-task{font-size:10px;color:var(--text-dim);margin-left:4px;font-weight:400}
.msg-agent .msg-body{border-left:2px solid var(--ag-color,var(--accent));padding-left:12px;margin-left:23px}
.msg-agent.streaming .msg-body{box-shadow:inset 0 0 18px var(--ag-color-glow,transparent)}
.msg-agent .ag-elapsed{font-size:9px;color:var(--text-dim);margin-left:auto;font-family:'SF Mono',monospace;opacity:.6}

/* ===== CEO Brief Card (작업 분배 시작 알림) ===== */
.brief-card{background:linear-gradient(135deg,rgba(248,250,252,.06),rgba(248,250,252,.02));border:1px solid rgba(248,250,252,.25);border-radius:14px;padding:14px 16px;margin-left:29px;animation:msgIn .5s cubic-bezier(.16,1,.3,1);position:relative;overflow:hidden;backdrop-filter:blur(8px)}
.brief-card::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(248,250,252,.08),transparent);transform:translateX(-100%);animation:briefSweep 2s ease-out}
@keyframes briefSweep{to{transform:translateX(100%)}}
.brief-head{font-family:'SF Mono',monospace;font-size:10px;letter-spacing:2px;color:#F8FAFC;margin-bottom:8px;text-transform:uppercase;opacity:.85}
.brief-text{font-size:13px;line-height:1.6;color:var(--text-bright);margin-bottom:10px;font-weight:500}
.brief-tasks{display:flex;flex-direction:column;gap:5px;margin-top:8px}
.brief-task{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text);padding:5px 8px;background:rgba(0,0,0,.3);border-radius:7px;border-left:2px solid var(--ag-color,var(--accent));animation:briefTaskIn .4s ease-out backwards}
.brief-task .bt-emoji{font-size:13px}
.brief-task .bt-name{font-family:'SF Mono',monospace;font-size:9.5px;font-weight:700;color:var(--ag-color,var(--accent));letter-spacing:.5px;text-transform:uppercase;min-width:62px}
.brief-task .bt-text{flex:1;color:var(--text-bright);font-size:11.5px}
@keyframes briefTaskIn{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}

/* ===== CEO Final Report Card ===== */
.report-card{background:linear-gradient(135deg,rgba(0,255,65,.04),rgba(0,143,17,.02));border:1px solid rgba(0,255,65,.3);border-radius:16px;padding:18px 20px;margin-left:29px;animation:msgIn .55s cubic-bezier(.16,1,.3,1);position:relative;overflow:hidden;backdrop-filter:blur(8px);box-shadow:0 8px 32px rgba(0,0,0,.4),0 0 24px rgba(0,255,65,.12)}
.report-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),var(--accent2),var(--accent),transparent);animation:reportLine 3s ease-in-out infinite}
@keyframes reportLine{0%,100%{opacity:.4}50%{opacity:1}}
.report-head{display:flex;align-items:center;justify-content:space-between;font-family:'SF Mono',monospace;font-size:10px;letter-spacing:2px;color:var(--accent);margin-bottom:12px;text-transform:uppercase;text-shadow:0 0 8px var(--accent-glow)}
.report-head .rh-tag{padding:2px 8px;border:1px solid rgba(0,255,65,.4);border-radius:5px;background:rgba(0,255,65,.06)}
.report-body{font-size:13px;line-height:1.75;color:var(--text-bright)}
.report-body h2{font-size:13px;color:var(--accent);margin:10px 0 6px;letter-spacing:.5px}
.report-body ul,.report-body ol{padding-left:20px;margin:4px 0}
.report-body li{margin:3px 0;color:var(--text)}
.report-body strong{color:var(--text-bright)}
.report-foot{margin-top:14px;padding-top:10px;border-top:1px solid rgba(0,255,65,.15);display:flex;align-items:center;justify-content:space-between;font-size:10px;font-family:'SF Mono',monospace;color:var(--text-dim)}
.report-foot .rf-link{color:var(--accent);cursor:pointer;text-decoration:none}
.report-foot .rf-link:hover{text-decoration:underline}

/* ===== Onboarding & Interview Cards ===== */
.onboard-card,.interview-card{background:linear-gradient(135deg,rgba(0,255,65,.05),rgba(0,143,17,.02));border:1px solid rgba(0,255,65,.28);border-radius:16px;padding:18px 20px;margin-left:29px;animation:msgIn .5s cubic-bezier(.16,1,.3,1);position:relative;overflow:hidden;backdrop-filter:blur(8px);box-shadow:0 8px 32px rgba(0,0,0,.4),0 0 18px rgba(0,255,65,.08)}
.onboard-card::before,.interview-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:reportLine 3s ease-in-out infinite}
.onboard-head,.interview-head{font-family:'SF Mono',monospace;font-size:10px;letter-spacing:2px;color:var(--accent);margin-bottom:8px;text-transform:uppercase;text-shadow:0 0 8px var(--accent-glow)}
.onboard-title,.interview-title{font-size:15px;font-weight:700;color:var(--text-bright);margin-bottom:6px}
.onboard-sub,.interview-sub{font-size:11.5px;color:var(--text-dim);line-height:1.6;margin-bottom:14px}
.onboard-options{display:flex;flex-direction:column;gap:6px}
.onboard-opt{display:flex;align-items:center;gap:10px;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:10px 14px;cursor:pointer;transition:all .25s;font-family:inherit;color:var(--text-bright);text-align:left}
.onboard-opt:hover{border-color:var(--accent);background:rgba(0,255,65,.06);transform:translateY(-1px);box-shadow:0 4px 14px var(--accent-glow)}
.onboard-opt .oo-icon{font-size:18px;flex-shrink:0}
.onboard-opt .oo-text{display:flex;flex-direction:column;gap:2px;flex:1}
.onboard-opt .oo-title{font-size:12.5px;font-weight:700}
.onboard-opt .oo-desc{font-size:10.5px;color:var(--text-dim);font-weight:400}
.interview-fields{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.interview-field label{display:block;font-size:10px;font-family:'SF Mono',monospace;color:var(--accent);letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}
.interview-field input{width:100%;background:var(--input-bg);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text-bright);font-family:inherit;font-size:13px;outline:none;transition:all .2s}
.interview-field input:focus{border-color:var(--accent);box-shadow:0 0 12px var(--accent-glow)}
.interview-actions{display:flex;justify-content:flex-end;gap:8px}
.interview-btn{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;padding:8px 18px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;transition:all .2s}
.interview-btn:hover{transform:translateY(-1px);box-shadow:0 4px 14px var(--accent-glow)}
.interview-btn.skip{background:transparent;border:1px solid var(--border2);color:var(--text-dim)}
.interview-btn.skip:hover{border-color:var(--accent);color:var(--text-bright);box-shadow:none}

/* 헤더에 회사명 표시 */
.brand-suffix{font-family:'SF Mono','JetBrains Mono',monospace;font-size:10px;color:var(--accent);font-weight:600;letter-spacing:.5px;margin-left:6px;padding:2px 7px;border:1px solid rgba(0,255,65,.3);border-radius:5px;background:rgba(0,255,65,.04);display:none}
body.corp-on .brand-suffix.has-name{display:inline-block}

/* ===== Cinematic dispatch overlay (boot moment) ===== */
.corp-overlay{position:absolute;inset:0;background:radial-gradient(circle at center,rgba(0,255,65,.06),rgba(0,0,0,.7));backdrop-filter:blur(2px);pointer-events:none;opacity:0;z-index:50;display:flex;align-items:center;justify-content:center}
body.corp-dispatching .corp-overlay{opacity:1;animation:overlayPulse 1.5s ease-out forwards}
@keyframes overlayPulse{0%{opacity:0}30%{opacity:1}100%{opacity:0}}
.corp-overlay-text{font-family:'SF Mono',monospace;font-size:11px;letter-spacing:4px;color:var(--accent);text-transform:uppercase;text-shadow:0 0 12px var(--accent),0 0 24px var(--accent2);animation:bootText 1.5s ease-out}
@keyframes bootText{0%{opacity:0;letter-spacing:0}30%{opacity:1;letter-spacing:6px}70%{opacity:1}100%{opacity:0;letter-spacing:8px}}

</style></head><body class="init">
<div class="header"><div class="header-left"><div class="logo">\u2726</div><span class="brand">Connect AI</span><span class="brand-suffix" id="brandSuffix"></span></div><div class="header-right"><select id="modelSel"></select><button class="btn-icon" id="corporateBtn" title="1인 기업 모드 — 에이전트 팀이 자동으로 일합니다 (현재: OFF)" style="opacity:0.5">👔</button><button class="btn-icon" id="internetBtn" title="인터넷 검색 켜기 (현재: OFF)" style="opacity: 0.4; filter: grayscale(1);">🌐</button><button class="btn-icon" id="thinkingBtn" title="Thinking Mode — AI가 어떻게 생각하는지 시각화" style="opacity:0.5">🎬</button><button class="btn-icon" id="brainBtn" title="내 지식 관리">\ud83e\udde0</button><button class="btn-icon" id="settingsBtn" title="설정">\u2699\ufe0f</button><button class="btn-icon" id="newChatBtn" title="새 대화 시작">+</button></div></div>
<div class="thinking-bar" id="thinkingBar"></div>
<div class="status-bar" id="statusBar">
  <span class="status-item" id="statFolder" title="지식 폴더 — 클릭하면 폴더 열림"><span class="status-icon">📁</span><span id="statFolderText">지식 폴더 미설정</span></span>
  <span class="sep">·</span>
  <span class="status-item" id="statGit" title="GitHub 백업 — 클릭하면 동기화"><span class="status-icon">☁️</span><span id="statGitText">GitHub 미연결</span></span>
  <span class="ag-mini">⚡ ANTIGRAVITY</span>
</div>
<div class="agent-board" id="agentBoard">
  <div class="ab-head">
    <span class="ab-title"><span id="abCompanyName">1인 기업 OS</span> <span class="ab-sub" id="abSub">— Multi-Agent Team</span></span>
    <span class="ab-folder" id="abFolder" title="회사 폴더 열기">📁 <span id="abFolderText">미설정</span></span>
  </div>
  <div class="ab-grid" id="abGrid"></div>
  <svg class="ab-svg" id="abSvg" preserveAspectRatio="none"></svg>
</div>

<div class="main-view" id="mainView">
<div class="corp-overlay" id="corpOverlay"><div class="corp-overlay-text">DISPATCHING AGENTS</div></div>
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
modelSel=document.getElementById('modelSel'),newChatBtn=document.getElementById('newChatBtn'),settingsBtn=document.getElementById('settingsBtn'),brainBtn=document.getElementById('brainBtn'),thinkingBtn=document.getElementById('thinkingBtn'),
internetBtn=document.getElementById('internetBtn'),attachBtn=document.getElementById('attachBtn'),injectLocalBtn=document.getElementById('injectLocalBtn'),fileInput=document.getElementById('fileInput'),attachPreview=document.getElementById('attachPreview'),
thinkingBar=document.getElementById('thinkingBar'),corporateBtn=document.getElementById('corporateBtn'),agentBoard=document.getElementById('agentBoard'),abGrid=document.getElementById('abGrid'),abSvg=document.getElementById('abSvg'),abFolder=document.getElementById('abFolder'),abCompanyName=document.getElementById('abCompanyName'),abFolderText=document.getElementById('abFolderText'),brandSuffix=document.getElementById('brandSuffix');
let loader=null,sending=false,pendingFiles=[],internetEnabled=false,corporateMode=false,officeOpen=false,corporateUnlocked=false;
/* Smart auto-scroll: only stick to the bottom if the user is already near it.
   If they scrolled up to read earlier messages, leave their view alone. */
function scrollChatToBottomIfNear(){
  if (!chat) return;
  const nearBottom = (chat.scrollHeight - chat.scrollTop - chat.clientHeight) < 120;
  if (nearBottom) chat.scrollTo({ top: chat.scrollHeight });
}
let agentMap={},agentCardEls={},agentStreamEls={};
let companyState={configured:false,name:'',dir:'',folderExists:false};
function welcomeHtml(){
  return '<div class="welcome"><div class="welcome-logo">✦</div>'
    + '<div class="ag-badge">⚡ Built for Antigravity</div>'
    + '<div class="welcome-title">안녕하세요! 무엇을 도와드릴까요?</div>'
    + '<div class="welcome-sub">내 지식과 연결된 100% 로컬 AI 워크스페이스.<br>인터넷 없이, API 비용 없이, 내 PC에서 바로 실행됩니다.</div>'
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
  scrollChatToBottomIfNear();
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
vscode.postMessage({type:'corporateInit'});
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
  el.appendChild(head);el.appendChild(body);chat.appendChild(el);scrollChatToBottomIfNear();
}
function escapeHtml(s){return String(s||'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]))}
function showInjectCard(title,relPath){
  const safeT=escapeHtml(title||'');const safeP=escapeHtml(relPath||'');
  const el=document.createElement('div');el.className='msg inject-card';
  el.innerHTML='<div class="inject-banner"><div class="inject-sweep"></div>'+
    '<div class="inject-header">\u2726 NEURAL INJECTION \u2022 KNOWLEDGE PACK RECEIVED</div>'+
    '<div class="inject-bar"><div class="inject-bar-fill"></div></div>'+
    '<div class="inject-title">'+safeT+'.md</div>'+
    '<div class="inject-path">\ud83d\udcc1 '+safeP+'</div>'+
    '<div class="inject-quote">I know '+safeT+'.</div>'+
    '</div>';
  chat.appendChild(el);scrollChatToBottomIfNear();
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
  chat.appendChild(loader);scrollChatToBottomIfNear();thinkingBar.classList.add('active');
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
function send(opts){
  const bypassCorporate=!!(opts&&opts.bypassCorporate);
  const corp=corporateMode&&!bypassCorporate;
  const text=input.value.trim();
  if((!text&&pendingFiles.length===0)||sending)return;
  document.body.classList.remove('init');
  const w=document.querySelector('.welcome');if(w)w.remove();
  document.querySelectorAll('.quick-actions').forEach(e=>e.remove());
  const displayText=text+(pendingFiles.length>0?'\\\\n\\ud83d\\udcce '+pendingFiles.map(f=>f.name).join(', '):'');
  /* corporate \ubaa8\ub4dc\uc778\ub370 \uc544\uc9c1 \uc14b\uc5c5 \uc548 \ub05d\ub0ac\uc73c\uba74 \uba85\ub839 \ucc28\ub2e8 */
  if(corp && !companyState.configured){
    setSending(false);
    addCorpBanner('\u26a0\ufe0f \ud68c\uc0ac \uc124\uc815\uc744 \uba3c\uc800 \uc644\ub8cc\ud574\uc8fc\uc138\uc694. (\uc704 \uce74\ub4dc\uc5d0\uc11c \uc120\ud0dd)');
    if(!companyState.folderExists)showOnboardingCard();else showInterviewCard();
    return;
  }
  addMsg(displayText,'user');
  input.value='';input.style.height='auto';setSending(true);
  if(corp && pendingFiles.length===0){
    /* \uce74\ub4dc \ubcf4\ub4dc\uac00 \uc2dc\uac01\ud654 \ub2f4\ub2f9 \u2014 \uc77c\ubc18 \ub85c\ub354 \uc548 \ub744\uc6c0 */
  } else {
    showLoader();
  }
  if(pendingFiles.length>0){
    vscode.postMessage({type:'promptWithFile',value:text||'\uc774 \ud30c\uc77c\uc744 \ubd84\uc11d\ud574\uc8fc\uc138\uc694.',model:modelSel.value,files:pendingFiles,internet:internetEnabled});
    pendingFiles=[];attachPreview.innerHTML='';attachPreview.classList.remove('visible');
  } else {
    vscode.postMessage({type:'prompt',value:text,model:modelSel.value,internet:internetEnabled,corporate:corp});
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
let thinkingModeOn=false;
thinkingBtn.addEventListener('click',()=>vscode.postMessage({type:'toggleThinking'}));
const statFolder=document.getElementById('statFolder'),statFolderText=document.getElementById('statFolderText');
const statGit=document.getElementById('statGit'),statGitText=document.getElementById('statGitText');
statFolder.addEventListener('click',()=>vscode.postMessage({type:'statusFolderClick'}));
statGit.addEventListener('click',()=>vscode.postMessage({type:'statusGitClick'}));
function updateStatus(s){
  // s = { folderPath, fileCount, githubUrl, lastSync, syncing }
  if(!s) return;
  statFolder.classList.remove('warn','ok','syncing');
  statGit.classList.remove('warn','ok','syncing');
  if(!s.folderPath){
    statFolder.classList.add('warn');
    statFolderText.textContent='지식 폴더 선택하기';
  } else {
    statFolder.classList.add('ok');
    statFolderText.textContent=(s.fileCount||0)+'개 지식';
    statFolder.title='지식 폴더: '+s.folderPath+' (클릭하면 열림)';
  }
  if(s.syncing){
    statGit.classList.add('syncing');
    statGitText.textContent='동기화 중...';
  } else if(!s.githubUrl){
    statGit.classList.add('warn');
    statGitText.textContent='GitHub 백업 설정';
  } else {
    statGit.classList.add('ok');
    statGitText.textContent = s.lastSync ? s.lastSync : 'GitHub 연결됨';
    statGit.title = s.githubUrl+' (클릭하면 URL 확인/변경 + 지금 동기화)';
  }
}
vscode.postMessage({type:'requestStatus'});
setInterval(()=>vscode.postMessage({type:'requestStatus'}), 30000);
stopBtn.addEventListener('click',()=>{vscode.postMessage({type:'stopGeneration'});hideLoader();setSending(false);if(streamBody){streamBody.classList.remove('stream-active')}streamEl=null;streamBody=null;});

/* ===== 1인 기업 모드 ===== */
function applyCorporateMode(on){
  corporateMode=on;
  document.body.classList.toggle('corp-on',on);
  corporateBtn.style.opacity=on?'1':'0.5';
  corporateBtn.style.background=on?'linear-gradient(135deg,var(--accent),var(--accent2))':'';
  corporateBtn.title='1인 기업 모드 — '+(on?'ON':'OFF (클릭해서 켜기)');
  input.placeholder=on?'한 줄 명령을 내리세요. 팀이 알아서 일합니다.':'무엇을 만들어 드릴까요?';
}

function showCorpGate(onUnlock){
  const old=document.getElementById('corpGateBackdrop');if(old)old.remove();
  const bd=document.createElement('div');bd.id='corpGateBackdrop';bd.className='cg-backdrop';
  bd.innerHTML='<div class="cg-modal" id="cgModal">'
    +'<span class="cg-corner bl"></span><span class="cg-corner br"></span>'
    +'<div class="cg-lock-wrap"><div class="cg-lock">🔒</div><div class="cg-tag">BETA · ACCESS REQUIRED</div></div>'
    +'<div class="cg-title">ENTERPRISE MODE</div>'
    +'<div class="cg-sub">기업 모드는 현재 테스트 중입니다.<br>비밀번호를 입력하면 사용할 수 있습니다.</div>'
    +'<div class="cg-input-wrap"><input id="corpGateInput" class="cg-input" type="password" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="● ● ● ●"></div>'
    +'<div id="corpGateErr" class="cg-err">// ACCESS DENIED — INVALID KEY</div>'
    +'<div class="cg-actions"><button class="cg-btn cancel" id="corpGateCancel">취소</button><button class="cg-btn ok" id="corpGateOk">UNLOCK ▸</button></div>'
    +'</div>';
  document.body.appendChild(bd);
  const inp=document.getElementById('corpGateInput'),err=document.getElementById('corpGateErr'),modal=document.getElementById('cgModal');
  setTimeout(()=>inp.focus(),120);
  function close(){bd.style.transition='opacity .25s';bd.style.opacity='0';setTimeout(()=>bd.remove(),250);}
  function submit(){
    if(inp.value==='0101'){
      corporateUnlocked=true;
      modal.style.transition='all .35s cubic-bezier(.16,1,.3,1)';
      modal.style.transform='scale(1.04)';
      modal.style.boxShadow='0 0 0 1px rgba(0,255,65,.2) inset,0 30px 80px rgba(0,0,0,.85),0 0 100px rgba(0,255,65,.5),0 0 200px rgba(0,255,65,.25)';
      setTimeout(()=>{close();onUnlock();},220);
    } else {
      err.classList.add('show');
      modal.classList.remove('shake');void modal.offsetWidth;modal.classList.add('shake');
      inp.value='';inp.focus();
    }
  }
  document.getElementById('corpGateOk').addEventListener('click',submit);
  document.getElementById('corpGateCancel').addEventListener('click',close);
  inp.addEventListener('input',()=>{if(err.classList.contains('show'))err.classList.remove('show');});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit();}else if(e.key==='Escape'){close();}});
  bd.addEventListener('click',e=>{if(e.target===bd)close();});
}

function runCorporateClick(){
  /* 회사 폴더가 아직 없거나 정체성이 비어있으면 사이드바에서 셋업 먼저 */
  if(!companyState.folderExists){
    applyCorporateMode(true);
    addCorpBanner('👔 처음이시군요. 회사 폴더를 어디에 만들까요?');
    showOnboardingCard();
    return;
  }
  if(!companyState.configured){
    applyCorporateMode(true);
    addCorpBanner('👔 회사 폴더는 있지만 정체성이 비어있어요. 빠르게 3가지만 알려주세요.');
    showInterviewCard();
    return;
  }
  /* 셋업 완료 → 가상 사무실 토글 (열려있으면 닫고, 닫혀있으면 엶) */
  if (officeOpen) {
    vscode.postMessage({type:'closeOffice'});
  } else {
    applyCorporateMode(true);
    vscode.postMessage({type:'toggleOffice'});
  }
}

corporateBtn.addEventListener('click',()=>{
  if(!corporateUnlocked){showCorpGate(runCorporateClick);return;}
  runCorporateClick();
});
abFolder.addEventListener('click',()=>vscode.postMessage({type:'openCompanyFolder'}));


function addCorpBanner(text){
  const m=document.createElement('div');m.className='msg';
  m.innerHTML='<div class="msg-body" style="color:#F8FAFC;font-size:12px;opacity:0.9;background:rgba(0,255,65,0.06);border:1px solid rgba(0,255,65,0.25);border-radius:10px;padding:8px 12px;margin-left:29px;font-family:\\'SF Mono\\',monospace;letter-spacing:0.3px;">'+esc(text)+'</div>';
  chat.appendChild(m);scrollChatToBottomIfNear();
}

function showOnboardingCard(){
  const old=document.getElementById('onboardCard');if(old)old.remove();
  const el=document.createElement('div');el.className='msg';el.id='onboardCard';
  el.innerHTML='<div class="onboard-card">'
    +'<div class="onboard-head">⚙️ COMPANY SETUP — 처음 시작</div>'
    +'<div class="onboard-title">회사 폴더를 어디에 만들까요?</div>'
    +'<div class="onboard-sub">모든 에이전트의 메모리·산출물이 이 폴더에 쌓입니다. 나중에 GitHub 백업으로 다른 PC에서도 이어갈 수 있어요.</div>'
    +'<div class="onboard-options">'
      +'<button class="onboard-opt" data-choice="default"><span class="oo-icon">🏠</span><span class="oo-text"><span class="oo-title">디폴트 위치에 만들기</span><span class="oo-desc">~/.connect-ai-brain/Company/ — 기존 두뇌 폴더 안</span></span></button>'
      +'<button class="onboard-opt" data-choice="pick"><span class="oo-icon">📂</span><span class="oo-text"><span class="oo-title">직접 폴더 선택</span><span class="oo-desc">아무 위치나 골라서 그 안에 Company/ 만들기</span></span></button>'
      +'<button class="onboard-opt" data-choice="import"><span class="oo-icon">📥</span><span class="oo-text"><span class="oo-title">다른 PC에서 가져오기 (GitHub)</span><span class="oo-desc">기존 회사 폴더의 Git URL로 복원</span></span></button>'
    +'</div></div>';
  chat.appendChild(el);scrollChatToBottomIfNear();
  el.querySelectorAll('.onboard-opt').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const choice=btn.getAttribute('data-choice');
      vscode.postMessage({type:'companySetup',choice:choice});
      el.remove();
    });
  });
}

function showInterviewCard(){
  const old=document.getElementById('interviewCard');if(old)old.remove();
  const el=document.createElement('div');el.className='msg';el.id='interviewCard';
  el.innerHTML='<div class="interview-card">'
    +'<div class="interview-head">🧭 CEO · 회사 정체성 인터뷰</div>'
    +'<div class="interview-title">3가지만 빠르게 알려주세요</div>'
    +'<div class="interview-sub">나머지는 작업하면서 자가학습이 채워줄 거예요. 빈 칸으로 둬도 OK.</div>'
    +'<div class="interview-fields">'
      +'<div class="interview-field"><label>회사·브랜드 이름</label><input id="ivName" placeholder="예: 제이코프 / 브랜드 미정"></div>'
      +'<div class="interview-field"><label>한 줄로 뭐 하시는 분이세요?</label><input id="ivOneLiner" placeholder="예: 자기계발 콘텐츠 만드는 1인 크리에이터"></div>'
      +'<div class="interview-field"><label>올해 목표 1개</label><input id="ivGoal" placeholder="예: 유튜브 구독자 10만"></div>'
    +'</div>'
    +'<div class="interview-actions">'
      +'<button class="interview-btn skip" id="ivSkipBtn">건너뛰기</button>'
      +'<button class="interview-btn" id="ivSubmitBtn">완료 →</button>'
    +'</div></div>';
  chat.appendChild(el);scrollChatToBottomIfNear();
  setTimeout(()=>{const f=document.getElementById('ivName');if(f)f.focus();},100);
  document.getElementById('ivSubmitBtn').addEventListener('click',()=>{
    const name=document.getElementById('ivName').value;
    const oneLiner=document.getElementById('ivOneLiner').value;
    const goal=document.getElementById('ivGoal').value;
    vscode.postMessage({type:'companyInterview',answers:{name:name,oneLiner:oneLiner,goal:goal}});
    el.remove();
  });
  document.getElementById('ivSkipBtn').addEventListener('click',()=>{
    vscode.postMessage({type:'companyInterview',answers:{name:'',oneLiner:'',goal:''}});
    el.remove();
  });
}

function applyCompanyState(s){
  if(!s)return;
  companyState.configured=!!s.configured;
  companyState.name=s.companyName||'';
  companyState.dir=s.companyDir||'';
  companyState.folderExists=!!s.folderExists;
  /* 헤더 */
  if(brandSuffix){
    if(companyState.name){
      brandSuffix.textContent='👔 '+companyState.name;
      brandSuffix.classList.add('has-name');
    } else {
      brandSuffix.textContent='';
      brandSuffix.classList.remove('has-name');
    }
  }
  /* 에이전트 보드 헤더 */
  if(abCompanyName)abCompanyName.textContent=companyState.name||'1인 기업 OS';
  if(abFolderText)abFolderText.textContent=companyState.dir||'미설정';
}
abFolder.addEventListener('click',()=>vscode.postMessage({type:'openCompanyFolder'}));

function renderAgentBoard(agents,companyDir){
  agentMap={};agentCardEls={};
  abGrid.innerHTML='';
  if(companyDir){const t=document.getElementById('abFolderText');if(t)t.textContent=companyDir;}
  agents.forEach(a=>{
    agentMap[a.id]=a;
    const card=document.createElement('div');
    card.className='ab-card idle';
    card.style.setProperty('--ag-color',a.color);
    card.style.setProperty('--ag-color-glow',a.color+'33');
    card.dataset.agent=a.id;
    card.innerHTML='<span class="ab-led"></span><div class="ab-emoji">'+a.emoji+'</div><div class="ab-name">'+a.name+'</div><div class="ab-status">IDLE</div>';
    card.addEventListener('click',()=>{
      vscode.postMessage({type:'openCompanyFolder',sub:'_agents/'+a.id});
    });
    abGrid.appendChild(card);
    agentCardEls[a.id]=card;
  });
}

function setCardState(agent,state,task){
  const c=agentCardEls[agent];if(!c)return;
  c.classList.remove('idle','thinking','working','done');
  c.classList.add(state);
  const s=c.querySelector('.ab-status');
  if(s){
    if(state==='idle')s.textContent='IDLE';
    else if(state==='thinking')s.textContent='THINKING';
    else if(state==='working')s.textContent='WORKING';
    else if(state==='done')s.textContent='DONE';
  }
  /* 작업 라벨 toast */
  const old=c.querySelector('.ab-task-toast');if(old)old.remove();
  if(task && (state==='working'||state==='thinking')){
    const t=document.createElement('div');t.className='ab-task-toast';t.textContent=task;
    c.appendChild(t);
    setTimeout(()=>{if(t.parentNode)t.style.opacity='0.0';setTimeout(()=>t.remove(),400);},2400);
  }
}

function resetAllAgentCards(){
  Object.keys(agentCardEls).forEach(id=>setCardState(id,'idle'));
  if(abSvg)abSvg.innerHTML='';
}

function drawDispatchBeams(taskAgentIds){
  if(!abSvg||!agentCardEls.ceo)return;
  abSvg.innerHTML='';
  const board=abGrid.getBoundingClientRect();
  const ceoR=agentCardEls.ceo.getBoundingClientRect();
  const cx=ceoR.left+ceoR.width/2-board.left;
  const cy=ceoR.top+ceoR.height/2-board.top;
  const w=abGrid.clientWidth,h=abGrid.clientHeight;
  abSvg.setAttribute('viewBox','0 0 '+w+' '+h);
  abSvg.setAttribute('width',w);abSvg.setAttribute('height',h);
  taskAgentIds.forEach((id,i)=>{
    const card=agentCardEls[id];if(!card||id==='ceo')return;
    const r=card.getBoundingClientRect();
    const tx=r.left+r.width/2-board.left;
    const ty=r.top+r.height/2-board.top;
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    /* curved beam */
    const mx=(cx+tx)/2,my=(cy+ty)/2-12;
    path.setAttribute('d','M '+cx+' '+cy+' Q '+mx+' '+my+' '+tx+' '+ty);
    path.setAttribute('class','ab-beam dispatching');
    const a=agentMap[id];if(a){path.style.stroke=a.color;path.style.filter='drop-shadow(0 0 6px '+a.color+')';}
    path.style.animationDelay=(i*0.08)+'s';
    abSvg.appendChild(path);
  });
}

function startAgentMsg(agent,task){
  const a=agentMap[agent];if(!a)return;
  if(agentStreamEls[agent]){endAgentMsg(agent);}
  const el=document.createElement('div');el.className='msg msg-agent streaming';
  el.style.setProperty('--ag-color',a.color);
  el.style.setProperty('--ag-color-glow',a.color+'40');
  const head=document.createElement('div');head.className='msg-head';
  const safeTask=esc(task||'').slice(0,80);
  head.innerHTML='<div class="av">'+a.emoji+'</div><span class="ag-tag">'+a.name+'</span><span class="ag-task">'+safeTask+'</span><span class="ag-elapsed" id="ge-'+agent+'-'+Date.now()+'">0:00</span>';
  const elapsedEl=head.querySelector('.ag-elapsed');
  const body=document.createElement('div');body.className='msg-body';
  el.appendChild(head);el.appendChild(body);chat.appendChild(el);scrollChatToBottomIfNear();
  const startedAt=Date.now();
  const tick=setInterval(()=>{
    if(!el.parentNode){clearInterval(tick);return;}
    const s=Math.floor((Date.now()-startedAt)/1000);
    if(elapsedEl)elapsedEl.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
  },1000);
  agentStreamEls[agent]={el:el,body:body,raw:'',tick:tick};
}

function appendAgentChunk(agent,value){
  let s=agentStreamEls[agent];
  if(!s){startAgentMsg(agent,'');s=agentStreamEls[agent];}
  if(!s)return;
  s.raw=(s.raw||'')+value;
  s.body.innerHTML=fmt(s.raw);
  scrollChatToBottomIfNear();
}

function endAgentMsg(agent){
  const s=agentStreamEls[agent];if(!s)return;
  s.el.classList.remove('streaming');
  if(s.tick)clearInterval(s.tick);
  delete agentStreamEls[agent];
}

function showBriefCard(brief,tasks){
  const el=document.createElement('div');el.className='brief-card';
  let tasksHtml='';
  tasks.forEach((t,i)=>{
    const a=agentMap[t.agent];if(!a)return;
    tasksHtml+='<div class="brief-task" style="--ag-color:'+a.color+';animation-delay:'+(0.1+i*0.08)+'s"><span class="bt-emoji">'+a.emoji+'</span><span class="bt-name">'+a.name+'</span><span class="bt-text">'+esc(t.task)+'</span></div>';
  });
  el.innerHTML='<div class="brief-head">🧭 CEO · 작업 분배</div><div class="brief-text">'+esc(brief)+'</div><div class="brief-tasks">'+tasksHtml+'</div>';
  chat.appendChild(el);scrollChatToBottomIfNear();
}

function showReportCard(brief,report,sessionPath,sessionRel){
  const el=document.createElement('div');el.className='report-card';
  el.innerHTML='<div class="report-head"><span>📝 CEO · 종합 보고서</span><span class="rh-tag">SESSION COMPLETE</span></div><div class="report-body">'+fmt(report)+'</div><div class="report-foot"><span>📁 '+esc(sessionPath||'')+'</span><span class="rf-link" data-sub="'+esc(sessionRel||'')+'">폴더 열기 →</span></div>';
  const link=el.querySelector('.rf-link');
  if(link)link.addEventListener('click',()=>vscode.postMessage({type:'openCompanyFolder',sub:link.dataset.sub.replace(/^Company\\//,'')}));
  chat.appendChild(el);scrollChatToBottomIfNear();
}

let streamEl=null,streamBody=null;
window.addEventListener('message',e=>{const msg=e.data;switch(msg.type){
  case 'response':hideLoader();setSending(false);addMsg(msg.value,'ai');break;
  case 'brainInject':showInjectCard(msg.title,msg.relPath);break;
  case 'officeStateChanged':{
    officeOpen=!!msg.open;
    /* Tie corp mode visual to office state — closing the office turns the button OFF visually too */
    corporateMode=officeOpen;
    document.body.classList.toggle('office-open',officeOpen);
    document.body.classList.toggle('corp-on',officeOpen);
    if(corporateBtn){
      corporateBtn.style.opacity=officeOpen?'1':'0.5';
      corporateBtn.style.background=officeOpen?'linear-gradient(135deg,var(--accent),var(--accent2))':'';
      corporateBtn.title=officeOpen?'1인 기업 모드 — 사무실 열림 (클릭해서 닫기)':'1인 기업 모드 — OFF (클릭해서 사무실 열기)';
    }
    if(input)input.placeholder=officeOpen?'한 줄 명령을 내리세요. 팀이 알아서 일합니다.':'무엇을 만들어 드릴까요?';
    break;
  }
  case 'error':hideLoader();setSending(false);addMsg(msg.value,'error');break;
  case 'streamStart':{
    hideLoader();
    streamEl=document.createElement('div');streamEl.className='msg';
    const h=document.createElement('div');h.className='msg-head';
    h.innerHTML='<div class="av av-ai">\u2726</div><span>Connect AI</span><span class="msg-time">'+getTime()+'</span>';
    streamBody=document.createElement('div');streamBody.className='msg-body stream-active';
    streamEl.appendChild(h);streamEl.appendChild(streamBody);chat.appendChild(streamEl);scrollChatToBottomIfNear();
    break;}
  case 'streamChunk':{
    if(streamBody){streamBody.innerHTML=fmt(streamBody._raw=(streamBody._raw||'')+msg.value);scrollChatToBottomIfNear();}
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
  case 'thinkingModeState':
    thinkingModeOn = !!msg.value;
    thinkingBtn.style.opacity = thinkingModeOn ? '1' : '0.5';
    thinkingBtn.style.background = thinkingModeOn ? 'linear-gradient(135deg,var(--accent),var(--accent2))' : '';
    thinkingBtn.title = thinkingModeOn ? 'Thinking Mode: ON (클릭으로 끄기)' : 'Thinking Mode — AI가 어떻게 생각하는지 시각화';
    break;
  case 'statusUpdate':
    updateStatus(msg.value);
    break;
  case 'attachCitations': {
    // Find the most recent AI message and append citation chips
    const msgs = chat.querySelectorAll('.msg');
    const last = msgs[msgs.length-1];
    if (last && msg.sources && msg.sources.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'citations';
      wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;margin-left:29px;font-size:11px;color:var(--text-dim);align-items:center';
      const label = document.createElement('span');
      label.textContent = '📚 출처:';
      label.style.cssText = 'opacity:0.7';
      wrap.appendChild(label);
      msg.sources.forEach(src => {
        const chip = document.createElement('button');
        chip.textContent = src.length > 28 ? src.slice(0, 26) + '…' : src;
        chip.title = src;
        chip.style.cssText = 'background:rgba(0,255,102,0.08);border:1px solid rgba(0,255,102,0.25);color:var(--accent);padding:3px 10px;border-radius:12px;font-size:10px;cursor:pointer;font-family:inherit;transition:all 0.2s';
        chip.onmouseover = () => { chip.style.background='rgba(0,255,102,0.18)'; chip.style.transform='translateY(-1px)'; };
        chip.onmouseout = () => { chip.style.background='rgba(0,255,102,0.08)'; chip.style.transform='translateY(0)'; };
        chip.onclick = () => vscode.postMessage({ type: 'highlightBrainNote', note: src });
        wrap.appendChild(chip);
      });
      last.appendChild(wrap);
      scrollChatToBottomIfNear();
    }
    break;
  }
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
  case 'injectPrompt':input.value=msg.value;input.style.height='auto';input.style.height=Math.min(input.scrollHeight,150)+'px';send({bypassCorporate:true});break;
  case 'corporateReady':
    renderAgentBoard(msg.agents||[],msg.companyDir||'');
    applyCompanyState(msg);
    break;
  case 'corporateState':
    applyCompanyState(msg);
    if(msg.note){addCorpBanner(msg.note);}
    /* 폴더는 막 만들어졌고 정체성이 비어있으면 바로 인터뷰 */
    if(corporateMode && companyState.folderExists && !companyState.configured){
      setTimeout(showInterviewCard,200);
    }
    if(corporateMode && companyState.configured){
      addCorpBanner('✅ '+(companyState.name||'회사')+' 설정 완료. 명령을 내려보세요.');
    }
    break;
  case 'agentDispatch':{
    hideLoader();
    document.body.classList.add('corp-dispatching');
    const taskIds=(msg.tasks||[]).map(t=>t.agent);
    showBriefCard(msg.brief||'',msg.tasks||[]);
    /* 모든 selected agent를 thinking 상태로 점등 */
    taskIds.forEach(id=>setCardState(id,'thinking'));
    /* SVG 빛줄기 */
    setTimeout(()=>drawDispatchBeams(['ceo'].concat(taskIds)),60);
    setTimeout(()=>{document.body.classList.remove('corp-dispatching');if(abSvg)abSvg.innerHTML='';},1700);
    break;
  }
  case 'agentStart':{
    hideLoader();
    setCardState(msg.agent,'working',msg.task);
    /* CEO는 카드 펄스만, specialist는 채팅 메시지도 시작 */
    if(msg.agent!=='ceo'){startAgentMsg(msg.agent,msg.task||'');}
    break;
  }
  case 'agentChunk':{
    appendAgentChunk(msg.agent,msg.value||'');
    break;
  }
  case 'agentEnd':{
    setCardState(msg.agent,'done');
    endAgentMsg(msg.agent);
    break;
  }
  case 'corporateReport':{
    showReportCard(msg.brief||'',msg.report||'',msg.sessionPath||'',msg.sessionRel||'');
    setSending(false);
    /* 잠시 후 모든 카드 idle로 복귀 */
    setTimeout(()=>{Object.keys(agentCardEls).forEach(id=>setCardState(id,'idle'));},2200);
    break;
  }
  case 'agentConfer':{
    const turns=msg.turns||[];
    if(turns.length===0)break;
    const el=document.createElement('div');el.className='msg confer-card';
    el.innerHTML='<div class="brief-card" style="--ag-color:#A78BFA;border-color:rgba(167,139,250,.3);background:linear-gradient(135deg,rgba(167,139,250,.05),rgba(167,139,250,.02))">'
      +'<div class="brief-head" style="color:#A78BFA">💬 자율 회의 · '+turns.length+'턴</div>'
      +'<div class="brief-tasks">'
      +turns.map(t=>{const fa=agentMap[t.from],ta=agentMap[t.to];if(!fa||!ta)return '';return '<div class="brief-task" style="--ag-color:'+fa.color+'"><span class="bt-emoji">'+fa.emoji+'</span><span class="bt-name">'+fa.name+'</span><span class="bt-text">→ '+ta.emoji+' '+esc(t.text)+'</span></div>';}).join('')
      +'</div></div>';
    chat.appendChild(el);scrollChatToBottomIfNear();
    break;
  }
  case 'decisionsLearned':{
    const decs=msg.decisions||[];
    if(decs.length===0)break;
    const el=document.createElement('div');el.className='msg';
    el.innerHTML='<div class="brief-card" style="--ag-color:#A78BFA;border-color:rgba(167,139,250,.4);background:linear-gradient(135deg,rgba(167,139,250,.06),rgba(167,139,250,.02));box-shadow:0 0 14px rgba(167,139,250,.15)">'
      +'<div class="brief-head" style="color:#A78BFA">🧠 자가학습 — decisions.md에 누적됨</div>'
      +'<div style="font-size:12px;color:var(--text-bright);line-height:1.7">'+decs.map(d=>'• '+esc(d)).join('<br>')+'</div>'
      +'</div>';
    chat.appendChild(el);scrollChatToBottomIfNear();
    break;
  }
  case 'telegramSent':{
    /* 사이드바에서는 작은 banner */
    addCorpBanner && addCorpBanner('📱 Secretary가 텔레그램으로 보고를 보냈어요.');
    break;
  }
} });
} catch(err) {
  document.body.innerHTML = '<div style="color:#ff4444;padding:20px;background:#111;height:100%;font-size:14px;overflow:auto;"><h2>\u26a0\ufe0f WEBVIEW JS CRASH</h2><pre>' + err.name + ': ' + err.message + '\\n' + err.stack + '</pre></div>';
}
</script></body></html>`;
    }
}
