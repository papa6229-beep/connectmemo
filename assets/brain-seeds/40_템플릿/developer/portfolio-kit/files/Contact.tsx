/* v3: 모든 브랜드 아이콘 inline SVG (lucide 의존성 없음). Mail은 유지. */
import { Mail } from 'lucide-react'

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
const LinkedinIcon = (p: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={p.className}>
    <path d="M20.5 2h-17A1.5 1.5 0 002 3.5v17A1.5 1.5 0 003.5 22h17a1.5 1.5 0 001.5-1.5v-17A1.5 1.5 0 0020.5 2zM8 19H5v-9h3zM6.5 8.25A1.75 1.75 0 118.3 6.5a1.78 1.78 0 01-1.8 1.75zM19 19h-3v-4.74c0-1.42-.6-1.93-1.38-1.93A1.74 1.74 0 0013 14.19a.66.66 0 000 .14V19h-3v-9h2.9v1.3a3.11 3.11 0 012.7-1.4c1.55 0 3.36.86 3.36 3.66z"/>
  </svg>
)

const socials = [
  { Icon: GithubIcon,   href: '#', label: 'GitHub' },
  { Icon: XIcon,        href: '#', label: 'X' },
  { Icon: LinkedinIcon, href: '#', label: 'LinkedIn' },
]

export default function Contact() {
  return (
    <section id="contact" className="py-16 sm:py-24 px-6 bg-gray-900 text-white">
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-sm font-semibold text-emerald-400 tracking-wider uppercase mb-3">Contact</p>
        <h2 className="text-3xl sm:text-5xl font-bold tracking-tight mb-5">
          {/* TODO: 행동 유도 한 줄 */}
          같이 일하실래요?
        </h2>
        <p className="text-lg text-gray-300 mb-10 max-w-xl mx-auto leading-relaxed">
          AI 자동화 · 풀스택 개발 · 프로덕트 컨설팅 — 12시간 안에 답변드립니다.
        </p>
        <a
          href="mailto:hello@example.com"
          className="inline-flex items-center gap-2 bg-white text-gray-900 px-8 py-4 rounded-xl font-semibold hover:bg-gray-100 transition-all"
        >
          <Mail className="w-5 h-5" />
          {/* TODO: 본인 이메일 */}
          hello@example.com
        </a>
        <div className="mt-12 flex justify-center gap-6">
          {socials.map(({ Icon, href, label }) => (
            <a key={label} href={href} aria-label={label} className="text-gray-400 hover:text-white transition">
              <Icon className="w-6 h-6" />
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}
