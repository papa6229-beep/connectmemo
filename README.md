# ✦ Connect AI LAB 

**100% 로컬 · 100% 오프라인 · 100% 무료**  
VS Code / Cursor 기반의 프리미엄 AI 코딩 에이전트입니다. 코드를 읽고, 작성하고, 터미널 명령어를 대신 실행해 줍니다.
이 프로젝트는 **EZERAI**와 **Connect AI LAB**이 함께 연구하고 제작했습니다.

---

## ✨ 핵심 기능 (v1.0.11 업데이트)

### 🚀 듀얼 AI 엔진 (Hybrid Backend) 완벽 지원!
이제 사용자 취향과 컴퓨터 사양에 맞춰 세상에서 제일 강력한 2가지 로컬 AI 엔진을 모두 지원합니다.
- **Ollama (기본 모드):** 초보자에게 추천합니다! 별도의 설정 없이 백그라운드에서 조용하고 강력하게 작동합니다.
- **LM Studio (고급 모드):** 맥북 유저나 고급 VRAM 관리가 필요한 분들께 강력히 추천합니다! 글로벌 표준 OpenAI(ChatGPT) 통신 규격과 100% 호환 적용 완료!

| 기능 | 설명 |
|:--|:--|
| ⚙️ **실시간 엔진 스위칭 UI** | 채팅창의 톱니바퀴 한 번 클릭으로 즉시 Ollama ↔ LM Studio 변환 및 자동 설정 완료 |
| 🛡️ **스마트 오토-페일오버** | Ollama가 응답하지 않을 경우, 플러그인이 스스로 0.1초 만에 LM Studio로 우회하여 안정적인 작업을 보장합니다. |
| 📁 **파일 자동 생성** | "포트폴리오 사이트 만들어줘" → 폴더/파일 자동 생성 및 에디터 오픈 |
| ✏️ **기존 파일 편집** | "배경색 바꿔줘" → 해당 코드를 찾아 정확히 교체 (자율주행 코딩) |
| 🖥️ **터미널 명령 실행** | "express 설치해줘" → `npm install express` 자동 실행 대기 |

---

## 📥 설치 방법 (상세 가이드)

### 방법 1: VSIX 파일 즉시 설치 (가장 간단)
1. Github [Releases](https://github.com/wonseokjung/connect-ai/releases) 메뉴에서 최신 `.vsix` 파일을 다운로드합니다.
2. VS Code(또는 Cursor)를 엽니다.
3. 단축키 `Cmd+Shift+P` (맥) 또는 `Ctrl+Shift+P` (윈도우)를 눌러 명령어 팔레트를 엽니다.
4. **`Extensions: Install from VSIX`** 를 검색하여 선택한 후, 방금 다운로드한 파일을 고릅니다. 끝! 🎉

### 방법 2: 플러그인 소스 직접 빌드
```bash
git clone https://github.com/wonseokjung/connect-ai.git
cd connect-ai
npm install
npm run compile
vsce package
```

---

## ⚙️ AI 엔진 세팅 가이드 (Ollama / LM Studio)

Connect AI LAB은 사용자의 컴퓨터 자원 안에서 돌아가는 오프라인 모델을 사용합니다. 아래 두 가지 엔진 중 편하신 것을 하나 사용하세요.

### 🟡 Option A: Ollama 설정 (초보자 추천)
1. **설치:** [Ollama 공식 홈페이지](https://ollama.com)에서 다운로드 또는 `brew install ollama`
2. **모델 다운로드:** 터미널을 열고 구글 최신 모델인 Gemma4를 받습니다.
```bash
ollama pull gemma4:e2b
```
3. **가동:** 백그라운드에서 자동으로 켜져 있습니다. (VS Code에서 Connect AI 채팅창의 ⚙️ 버튼을 눌러 `Ollama`가 선택되어 있는지 확인하세요!)

### 🔵 Option B: LM Studio 설정 (애플 실리콘 맥 유저 고속도 추천)
1. **설치:** [LM Studio 공식 홈페이지](https://lmstudio.ai/)에서 다운로드합니다.
2. **모델 다운로드:** 프로그램 내부에서 원하는 모델(예: `Gemma4` 또는 Llama)을 검색해 다운로드합니다.
3. **로컬 서버 켜기 (매우 중요! ⭐️):**
   - LM Studio 왼쪽 얇은 메뉴바에서 **`< >` 기호 아이콘 (Developer 탭)**을 클릭합니다.
   - 중앙 화면 상단에 있는 **`Status: Stopped`** 라고 적힌 스위치 버튼을 눌러서 **ON(초록불)** 상태로 켭니다!! (켜지지 않으면 에러가 납니다)
   - 서버가 정상 작동하면 `http://127.0.0.1:1234` 포트가 열렸다고 아래 로그에 출력됩니다.
4. VS Code로 돌아와 Connect AI 채팅창의 **⚙️ 톱니바퀴 버튼**을 누르고 **`LM Studio (고급형)`**을 클릭하세요. (설정이 연동되며 1초 만에 곧바로 통신을 시작합니다!)

---

## 🔒 절대 프라이버시 원칙
- ❌ **클라우드 서버 없음 / 인터넷 연결 불필요**
- ❌ **데이터 수집 없음** (작성된 모든 코드는 컴퓨터 밖으로 나가지 않습니다.)
- ✅ 회사/개인 프로젝트 보안 유지의 최적해

---

## 📄 라이선스
MIT License — 자유롭게 사용, 수정, 배포 가능합니다.

**Designed & Developed with ❤️ by EZERAI and Connect AI LAB**
