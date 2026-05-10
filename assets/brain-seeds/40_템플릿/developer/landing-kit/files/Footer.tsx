import { Github, Twitter, Youtube } from 'lucide-react'

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

const socials = [
  { Icon: Github, href: '#', label: 'GitHub' },
  { Icon: Twitter, href: '#', label: 'Twitter' },
  { Icon: Youtube, href: '#', label: 'YouTube' },
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
