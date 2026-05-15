# 🚀 Beep AI Studio — 1인 AI 기업 핸드북

<p align="center">
  <img src="assets/icon.png" width="120" alt="Beep AI Logo" />
</p>

## 🌟 Vision: 1인 기업, 9명의 AI 직원과 함께
Beep AI Studio는 **100% 로컬 환경**에서 작동하는 자율 지식 및 비즈니스 엔진입니다. 인터넷 연결 없이도 나만의 AI 팀이 24시간 협업하여 아이디어를 현실로 만듭니다.

---

## 🏢 AI 조직 구성 (Our Team)

| 에이전트 | 역할 | 핵심 도구 |
|:--|:--|:--|
| **👔 CEO (Jay)** | 총괄 지휘 및 의사결정 | `dispatch`, `analyze_goals` |
| **👨‍💻 개발자 (Kodari)** | 웹/게임 서비스 구현 | `pack_apply`, `git_sync` |
| **📢 마케팅 (Leo)** | 유튜브 및 트렌드 분석 | `youtube_analysis`, `copywriting` |
| **💰 재무 (Hyunbin)** | 매출 분석 및 BM 설계 | `revenue_report`, `price_strategy` |
| **🎨 디자인 (Sua)** | UI/UX 및 그래픽 디자인 | `asset_gen` |
| **⚙️ 운영 (Youngsuk)** | 시스템 관리 및 자동화 | `log_monitor`, `cron_setup` |

---

## 📂 지식 체계 (Brain Structure)

이 저장소는 **P-Reinforce** 아키텍처에 따라 구조화되어 있습니다.

- `00_Raw`: 가공되지 않은 외부 지식/데이터 저장소
- `10_Wiki`: 에이전트들이 분석하고 정제한 핵심 지식
  - `Topics`: 개념 및 이론 정리
  - `Projects`: 현재 진행 중인 비즈니스 프로젝트
  - `Decisions`: 주요 의사결정 기록
  - `Skills`: AI 직원이 학습한 새로운 스킬
- `_company`: 기업의 가상 조직도 및 에이전트 프로필

---

## 🛠️ 시작하기 (How to Operate)

1. **지식 주입**: `00_Raw` 폴더에 새로운 정보를 저장하면 AI 에이전트들이 스스로 분석하여 `10_Wiki`로 구조화합니다.
2. **명령 하달**: VS Code / Cursor 채팅창을 통해 CEO에게 업무를 지시하세요.
   - *"이번 달 종합 매출 보고서 작성해줘"*
   - *"강아지 사주 서비스 랜딩 페이지 만들어줘"*
3. **자동 동기화**: 모든 작업 결과는 GitHub 저장소에 실시간으로 커밋 및 푸시됩니다.

---

## 🔒 Security & Privacy
- **100% Local Inference**: 모든 데이터는 당신의 로컬 PC에서만 처리됩니다.
- **Zero Cloud API**: 외부 서버로 당신의 비즈니스 비밀이 유출되지 않습니다.

---

<p align="center">
  <strong>Built for [User Name] × Beep AI Studio</strong><br/>
  Powered by Antigravity v2
</p>
