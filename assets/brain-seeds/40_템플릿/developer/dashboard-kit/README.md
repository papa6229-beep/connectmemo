# 📋 Dashboard Kit — SaaS·관리자 대시보드

## 구조
- **DashboardLayout**: 사이드바 + 탑바 + 메인 영역 통합
- **Sidebar**: 좌측 네비, 활성 메뉴 강조, 하단 사용자 카드
- **Topbar**: 검색·알림·아바타
- **StatsCards**: 4개 KPI 카드 (값·증감률·아이콘)
- **RecentTable**: 최근 활동 테이블 (상태 배지 포함)

## 사용
1. `web_init` TEMPLATE=vite-react PROJECT_NAME=my-dashboard
2. files/ 의 5개 컴포넌트 → `src/components/`
3. `npm install lucide-react`
4. `App.tsx` 교체:
```tsx
import DashboardLayout from './components/DashboardLayout'
export default function App() { return <DashboardLayout /> }
```

## 커스터마이징
- 색: `slate-900` (사이드바) / `gray-50` (메인) — Tailwind 변경으로 브랜드 색 적용
- KPI 데이터: `StatsCards.tsx`의 `stats` 배열 수정
- 테이블 데이터: `RecentTable.tsx`의 `rows` 배열 수정
- 메뉴 항목: `Sidebar.tsx`의 `menuItems` 배열

## 고도화 (다음 단계)
- 차트 라이브러리 추가: `npm install recharts`
- 라우터: `npm install react-router-dom`
- 데이터 fetch: `npm install @tanstack/react-query`
