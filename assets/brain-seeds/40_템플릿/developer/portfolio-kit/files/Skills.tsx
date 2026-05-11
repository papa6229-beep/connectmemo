import { Code2, Palette, Zap } from 'lucide-react'

const groups = [
  {
    icon: Code2,
    title: 'Engineering',
    items: ['TypeScript / React / Next.js', 'Python · AI 자동화', 'PostgreSQL · Drizzle ORM', 'Docker · Vercel · Cloudflare'],
  },
  {
    icon: Palette,
    title: 'Design',
    items: ['Figma · Framer · Webflow', 'Tailwind · Component Systems', 'Brand · Identity · Logo'],
  },
  {
    icon: Zap,
    title: 'AI & Automation',
    items: ['LLM 통합 · 로컬 모델', 'RAG · Vector DB', 'YouTube · Content 자동화'],
  },
]

export default function Skills() {
  return (
    <section id="skills" className="py-16 sm:py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-12">
          <p className="text-sm font-semibold text-emerald-600 tracking-wider uppercase mb-2">Skills</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            {/* TODO: 전문 분야 한 줄 */}
            이 도구·언어로 일합니다
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {groups.map((g) => {
            const Icon = g.icon
            return (
              <div key={g.title} className="bg-white border border-gray-200 rounded-2xl p-6 hover:border-emerald-600 transition">
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 mb-4">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-lg mb-3">{g.title}</h3>
                <ul className="space-y-2">
                  {g.items.map(item => (
                    <li key={item} className="text-sm text-gray-600 flex items-start gap-2">
                      <span className="text-emerald-600 mt-0.5">▸</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
