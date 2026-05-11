import { Mail, Github, Twitter, Linkedin } from 'lucide-react'

const socials = [
  { Icon: Github,   href: '#', label: 'GitHub' },
  { Icon: Twitter,  href: '#', label: 'Twitter' },
  { Icon: Linkedin, href: '#', label: 'LinkedIn' },
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
