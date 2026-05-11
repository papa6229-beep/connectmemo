/* v3: lucide-react 의 브랜드 아이콘 (Github·Twitter·Youtube) 가 최신 버전에서
   상표권 이유로 export 제거. 모두 inline SVG 로 교체 — 외부 의존성 없음. */

const sections = [
  {
    title: '제품',
    links: [
      { label: '기능', href: '#features' },
      { label: '요금', href: '#pricing' },
      { label: '문서', href: '#' },
      { label: '변경 로그', href: '#' },
    ],
  },
  {
    title: '회사',
    links: [
      { label: '소개', href: '#' },
      { label: '블로그', href: '#' },
      { label: '연락처', href: '#' },
    ],
  },
  {
    title: '법적 고지',
    links: [
      { label: '이용 약관', href: '#' },
      { label: '개인정보 처리방침', href: '#' },
    ],
  },
]

/* 브랜드 아이콘 모두 inline SVG (lucide 의존성 없음 — 라이브러리 변경에 안전) */
const GithubIcon = (p: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={p.className}>
    <path d="M12 .5C5.4.5 0 5.9 0 12.5c0 5.3 3.4 9.8 8.2 11.4.6.1.8-.3.8-.6V21c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.3-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2 1-.3 2-.4 3-.4s2 .1 3 .4c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.9 1.2 2 1.2 3.3 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6C20.6 22.3 24 17.8 24 12.5 24 5.9 18.6.5 12 .5z"/>
  </svg>
)
const XIcon = (p: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={p.className}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
)
const YoutubeIcon = (p: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={p.className}>
    <path d="M21.582 6.186a2.506 2.506 0 0 0-1.768-1.768C18.254 4 12 4 12 4s-6.254 0-7.814.418a2.506 2.506 0 0 0-1.768 1.768C2 7.746 2 12 2 12s0 4.254.418 5.814a2.506 2.506 0 0 0 1.768 1.768C5.746 20 12 20 12 20s6.254 0 7.814-.418a2.506 2.506 0 0 0 1.768-1.768C22 16.254 22 12 22 12s0-4.254-.418-5.814zM10 15.464V8.536L16 12z" />
  </svg>
)

const socials = [
  { Icon: GithubIcon,  href: '#', label: 'GitHub' },
  { Icon: XIcon,       href: '#', label: 'X' },
  { Icon: YoutubeIcon, href: '#', label: 'YouTube' },
]

export default function Footer() {
  return (
    <footer className="px-6 py-12 border-t border-gray-200">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
          <div className="col-span-2 md:col-span-1">
            <h3 className="font-bold text-gray-900 mb-3">
              {/* TODO: 회사·제품 이름 */}
              Connect AI
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed">
              {/* TODO: 한 줄 소개 */}
              AI 1인 기업의 두뇌. 100% 로컬, 100% 무료.
            </p>
          </div>
          {sections.map((s) => (
            <div key={s.title}>
              <h4 className="font-semibold text-gray-900 text-sm mb-3">{s.title}</h4>
              <ul className="space-y-2">
                {s.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-sm text-gray-500 hover:text-gray-900 transition">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-8 border-t border-gray-100">
          <p className="text-sm text-gray-500">
            © {new Date().getFullYear()} Connect AI. All rights reserved.
          </p>
          <div className="flex gap-4">
            {socials.map(({ Icon, href, label }) => (
              <a
                key={label}
                href={href}
                aria-label={label}
                className="text-gray-400 hover:text-gray-900 transition"
              >
                <Icon className="w-5 h-5" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
