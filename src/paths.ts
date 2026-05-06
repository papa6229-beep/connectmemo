/* v2.89.66 — 경로 유틸리티 모듈.
 *
 * 두뇌 폴더(`~/.connect-ai-brain/`) 와 회사 폴더(`<brain>/_company/` 또는 detached path) 의
 * 위치를 결정하는 함수들. 분리 이유:
 * - tracker, telegram, github-sync 등 여러 모듈이 이 경로 함수들을 의존
 * - extension.ts에 두면 의존성이 한 점에 모이는데 그 한 점이 25,000줄이라 import
 *   순서·circular 문제 발생
 *
 * 의존: vscode 설정 읽기 (workspace.getConfiguration). settings.json 사용자 입력 우선.
 */

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const COMPANY_SUBDIR = '_company';

/** Settings.json `connectAiLab.localBrainPath` 입력 처리. ~/ 와 빈 문자열 케이스 정규화. */
export function _expandTilde(p: string): string {
    if (!p) return '';
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
    if (trimmed === '~') return os.homedir();
    return trimmed;
}

/** 사용자가 settings.json에 입력한 raw 경로 → 절대 경로.
 *  ~/ 정규화 + 절대 경로만 받음 (상대 경로는 surprise 방지로 거부 → 빈 문자열).
 *  빈 입력 / 잘못된 입력 모두 빈 문자열로 통일. */
export function _resolvePathInput(raw: string): string {
    let s = (raw || '').trim();
    if (!s) return '';
    if (s.startsWith('~/') || s === '~') {
        s = s.replace(/^~/, os.homedir());
    }
    if (!path.isAbsolute(s)) return ''; // ignore non-absolute to avoid surprise
    return path.normalize(s);
}

/** 두뇌 폴더 위치 결정. settings.json `localBrainPath` 우선, 없으면 `~/.connect-ai-brain/`. */
export function _getBrainDir(): string {
    try {
        const cfg = vscode.workspace.getConfiguration('connectAiLab');
        const raw = cfg.get<string>('localBrainPath', '') || '';
        const resolved = _resolvePathInput(raw);
        if (resolved) return resolved;
    } catch { /* config unavailable in some hot paths — fall through */ }
    return path.join(os.homedir(), '.connect-ai-brain');
}

/** 사용자가 명시적으로 두뇌 폴더 경로를 설정했는지. */
export function _isBrainDirExplicitlySet(): boolean {
    try {
        const cfg = vscode.workspace.getConfiguration('connectAiLab');
        const raw = cfg.get<string>('localBrainPath', '') || '';
        return !!raw.trim();
    } catch { return false; }
}

/** 회사 폴더 위치. settings.json `companyDir` 우선 (별도 위치). 없으면 `<brain>/_company/`. */
export function getCompanyDir(): string {
    try {
        const raw = vscode.workspace.getConfiguration('connectAiLab').get<string>('companyDir', '') || '';
        const resolved = _resolvePathInput(raw);
        if (resolved) return resolved;
    } catch { /* config unavailable in some hot paths — fall through */ }
    return path.join(_getBrainDir(), COMPANY_SUBDIR);
}
