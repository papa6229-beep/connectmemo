# 📋 Portfolio Kit — 1인 크리에이터·프리랜서

## 4-섹션 구조
1. **Nav** — 상단 sticky 네비 (로고 + 메뉴 + CTA)
2. **About** — 자기 소개 + 사진 + 한 줄 가치 제안
3. **Work** — 작업물 갤러리 (그리드, 호버 디테일)
4. **Skills** — 전문 분야 + 경력 + 도구
5. **Contact** — 이메일 폼 + 소셜 링크

## 사용
1. `web_init` TEMPLATE=vite-react PROJECT_NAME=my-portfolio
2. `pack_apply` (또는 수동) — 이 폴더의 5개 파일을 `src/components/`로
3. `npm install lucide-react`
4. `App.tsx` 교체:
```tsx
import Nav from './components/Nav'
import About from './components/About'
import Work from './components/Work'
import Skills from './components/Skills'
import Contact from './components/Contact'

export default function App() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <Nav />
      <About />
      <Work />
      <Skills />
      <Contact />
    </main>
  )
}
```

## 컨벤션
- 단색 강조: `text-gray-900` + `bg-white` 기본
- 액센트: `text-emerald-600` 또는 사용자 선택 색
- 사진: Unsplash placeholder URL — 사용자가 본인 작품으로 교체
- 모바일 first

## 카피 가이드
- About: 본인 이름 + "[직업] 입니다" + 한 줄 가치
- Work: 작업물마다 제목 + 한 줄 설명 + 외부 링크
- Skills: 3-5개 그룹 (예: 디자인·코딩·마케팅)
- Contact: 이메일 1개 + Twitter/Instagram/LinkedIn 중 2개
