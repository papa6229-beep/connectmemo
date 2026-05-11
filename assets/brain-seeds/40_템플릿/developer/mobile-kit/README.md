# 📱 Mobile Kit (Expo) — 진짜 모바일 앱

## 무엇이 들어있나
- **App.tsx** — Bottom Tab Navigator (3 화면)
- **HomeScreen.tsx** — 메인 피드 (카드 리스트)
- **ProfileScreen.tsx** — 프로필 + 통계
- **SettingsScreen.tsx** — 토글 + 메뉴

## Expo의 장점 (vs React Native CLI)
- ✅ Xcode·Android Studio 셋업 필요 X (개발 시점)
- ✅ 폰에서 **Expo Go** 앱 설치 → QR 스캔 → 즉시 실행
- ✅ 코드 저장 → 폰에 자동 반영 (HMR)
- ✅ iOS·Android·Web 동시 실행

## 사용 (사용자 머신)
### 1. 셋업 (`web_init` TEMPLATE=expo)
```bash
# Connect AI 의 web_init 도구가 자동으로:
npx create-expo-app@latest my-app --template blank-typescript
cd my-app
```

### 2. 의존성 자동 추가
```bash
npx expo install @react-navigation/native @react-navigation/bottom-tabs \
                 react-native-screens react-native-safe-area-context
```

### 3. files/ 의 4개 파일을 프로젝트 루트로 복사
```
files/App.tsx                       → App.tsx (덮어쓰기)
files/screens/HomeScreen.tsx        → screens/HomeScreen.tsx
files/screens/ProfileScreen.tsx     → screens/ProfileScreen.tsx
files/screens/SettingsScreen.tsx    → screens/SettingsScreen.tsx
```

### 4. 실행
```bash
npm start
```
→ QR 코드 표시. 폰에 **Expo Go** 앱 (App Store / Play Store 무료) 설치 후 QR 스캔.

### 5. 화면 확인
- 하단 탭: 🏠 Home · 👤 Profile · ⚙️ Settings
- 각 화면 데이터·디자인은 TODO 주석 위치에서 본인 앱으로 변경

## 진짜 배포 (선택)
- **iOS 앱스토어**: Apple Developer 계정 ($99/년) 필요
- **Android 플레이**: Google Play Console ($25 1회) 필요
- **TestFlight / 내부 테스트**: 무료 — 친구·베타 사용자에 배포 가능
- `eas build` 명령으로 진짜 .ipa / .apk 빌드 (Expo 클라우드 빌드 무료 한도 있음)
