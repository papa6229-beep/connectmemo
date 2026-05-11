#!/usr/bin/env python3
# version: pack_apply_v2
"""두뇌의 템플릿 팩을 사용자 프로젝트에 한 번에 적용.

흐름:
  1. KIT_NAME — 두뇌의 40_템플릿/developer/<KIT_NAME>/ 폴더
  2. PROJECT_PATH — 적용할 사용자 프로젝트 (비우면 web_init 결과 자동)
  3. manifest.json 의 apply.{copy_to, post_install, app_imports, app_body} 사용:
     - files/* → PROJECT_PATH/copy_to/ (예: src/components/)
     - post_install: npm install / npx expo install 자동 실행
     - app_imports: App.tsx 또는 App.tsx 에 import 추가 + JSX 본문 자동
  4. 결과 출력 — 다음 단계 안내 (npm run dev 등)

이 도구가 코다리에게 주는 슈퍼파워:
  - 매뉴얼 cp + npm install 호출 안 해도 됨
  - 한 명령으로 "키트 적용 완료"
  - 의존성 누락 없음 (manifest 가 진실 소스)
"""
import os, sys, json, subprocess, shutil


HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "pack_apply.json")
WEB_INIT_CFG = os.path.join(HERE, "web_init.json")


def _log(msg, kind="info"):
    prefix = {"info": "📋", "ok": "✅", "warn": "⚠️ ", "err": "❌", "step": "▸"}.get(kind, "•")
    print(f"{prefix} {msg}", file=sys.stderr, flush=True)


def _load(p):
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _run(cmd, cwd):
    _log(f"$ {cmd}", "step")
    r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        for line in (r.stderr or "").splitlines()[-8:]:
            _log(line, "warn")
        return False
    return True


def _copy_tree(src_dir, dst_dir):
    os.makedirs(dst_dir, exist_ok=True)
    copied = 0
    for root, _dirs, files in os.walk(src_dir):
        rel = os.path.relpath(root, src_dir)
        target = os.path.join(dst_dir, rel) if rel != "." else dst_dir
        os.makedirs(target, exist_ok=True)
        for f in files:
            shutil.copy2(os.path.join(root, f), os.path.join(target, f))
            copied += 1
    return copied


def _find_app_file(project_path):
    """vite/next 모두 커버. src/App.tsx 우선, 없으면 App.tsx (expo)."""
    for cand in ["src/App.tsx", "App.tsx", "src/app/page.tsx", "app/page.tsx"]:
        p = os.path.join(project_path, cand)
        if os.path.exists(p):
            return p
    return None


def _update_app_tsx(app_path, imports, body):
    """App.tsx 를 깨끗하게 새로 작성. 원본은 .backup 으로 보존.
    v2: regex 부분 매칭으로 옛 JSX 가 남던 사고 → 전체 덮어쓰기 + 백업 방식으로 변경."""
    try:
        with open(app_path, "r", encoding="utf-8") as f:
            original = f.read()
    except Exception:
        return False

    # 이미 키트 적용됐으면 skip
    if all(f"from './components/{n}'" in original for n in imports):
        return False

    # 백업 — 사용자가 손댄 거 잃지 않게
    try:
        backup_path = app_path + ".backup"
        if not os.path.exists(backup_path):
            with open(backup_path, "w", encoding="utf-8") as f:
                f.write(original)
    except Exception:
        pass

    # 새 App.tsx — 깨끗한 최소 버전
    import_lines = "\n".join([f"import {n} from './components/{n}'" for n in imports])
    new_content = f"""{import_lines}

export default function App() {{
  return (
    <main className="min-h-screen bg-white text-gray-900">
      {body}
    </main>
  );
}}
"""
    try:
        with open(app_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return True
    except Exception:
        return False


def main():
    cfg = _load(CONFIG)
    init_cfg = _load(WEB_INIT_CFG)

    kit_name = (cfg.get("KIT_NAME") or "").strip()
    if not kit_name:
        _log("KIT_NAME 비어있음. 'landing-kit', 'portfolio-kit', 'dashboard-kit', 'mobile-kit' 중 하나", "err")
        sys.exit(1)

    project = (cfg.get("PROJECT_PATH") or "").strip()
    if not project:
        project = (init_cfg.get("LAST_PROJECT") or "").strip()
    if not project:
        _log("PROJECT_PATH 비어있고 web_init 기록도 없음", "err")
        sys.exit(1)
    project = os.path.expanduser(project)
    if not os.path.isdir(project):
        _log(f"프로젝트 폴더 없음: {project}", "err")
        sys.exit(1)

    # 두뇌의 키트 폴더 찾기
    brain_root = os.path.expanduser("~/.connect-ai-brain")
    if not os.path.exists(brain_root):
        # fallback: 환경변수 또는 .connect-ai-brain-imported
        for cand in ["~/Downloads/지식메모리", "~/.connect-ai-brain-imported"]:
            cand_path = os.path.expanduser(cand)
            if os.path.exists(cand_path):
                brain_root = cand_path
                break
    kit_dir = os.path.join(brain_root, "40_템플릿", "developer", kit_name)
    if not os.path.exists(kit_dir):
        _log(f"키트 없음: {kit_dir}", "err")
        _log(f"먼저 EZER Pack Vault 에서 '{kit_name}' 주입하세요.", "info")
        sys.exit(1)

    manifest_path = os.path.join(kit_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        _log(f"manifest 없음: {manifest_path}", "err")
        sys.exit(1)
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    apply = manifest.get("apply", {})
    copy_to = apply.get("copy_to", "src/components/")
    post_install = apply.get("post_install", [])
    app_imports = apply.get("app_imports", [])
    app_body = apply.get("app_body", "")

    _log(f"키트: {manifest.get('name', kit_name)} → {project}", "info")
    _log(f"기반: {manifest.get('base', '?')}", "info")

    # 1) 파일 복사
    src_files = os.path.join(kit_dir, "files")
    dst_files = os.path.join(project, copy_to.lstrip("./"))
    if not os.path.exists(src_files):
        _log("키트의 files/ 폴더 없음 — 파일 복사 스킵", "warn")
    else:
        n = _copy_tree(src_files, dst_files)
        _log(f"{n}개 파일 복사 → {dst_files}", "ok")

    # 2) 의존성 자동 설치
    if post_install:
        _log(f"의존성 {len(post_install)}개 설치 중...", "info")
        for cmd in post_install:
            ok = _run(cmd, cwd=project)
            if not ok:
                _log(f"부가 명령 실패: {cmd} — 계속 진행", "warn")

    # 3) App.tsx 자동 업데이트 (best-effort)
    if app_imports:
        app_file = _find_app_file(project)
        if app_file:
            changed = _update_app_tsx(app_file, app_imports,
                                      app_body or "\n".join([f"<{n} />" for n in app_imports]))
            if changed:
                _log(f"App.tsx 자동 업데이트: {app_file}", "ok")
            else:
                _log(f"App.tsx 이미 정정됨 또는 패턴 매칭 실패 — 수동 확인: {app_file}", "warn")
        else:
            _log("App.tsx 못 찾음 — 수동으로 import + JSX 추가 필요", "warn")

    # 결과
    print()
    _log(f"적용 완료: {kit_name}", "ok")
    _log(f"다음 단계:", "info")
    _log(f"  cd {project}", "info")
    if "expo" in (manifest.get("base", "").lower()):
        _log(f"  npm start  # → 폰에 Expo Go 깔고 QR 스캔", "info")
    else:
        _log(f"  npm run dev  # → http://localhost:5173 (또는 3000)", "info")


if __name__ == "__main__":
    main()
