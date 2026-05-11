import { ExternalLink } from 'lucide-react'

const works = [
  {
    title: 'Connect AI',
    desc: 'AI 1인 기업 두뇌 — 9명 에이전트 + 로컬 LLM',
    img: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&q=80',
    link: '#',
    tag: 'Product',
  },
  {
    title: 'EZER AI',
    desc: '드래그앤드롭 AI 워크플로우 빌더',
    img: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&q=80',
    link: '#',
    tag: 'Tool',
  },
  {
    title: 'YouTube 채널',
    desc: 'AI 1인 기업 강의 4M+ 누적 조회',
    img: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&q=80',
    link: '#',
    tag: 'Content',
  },
]

export default function Work() {
  return (
    <section id="work" className="py-16 sm:py-24 px-6 bg-gray-50">
      <div className="max-w-6xl mx-auto">
        <div className="mb-12">
          <p className="text-sm font-semibold text-emerald-600 tracking-wider uppercase mb-2">Work</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            {/* TODO: 작업 모음 한 줄 */}
            만들어 운영 중인 것들
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {works.map((w) => (
            <a
              key={w.title}
              href={w.link}
              className="group block bg-white rounded-2xl overflow-hidden border border-gray-200 hover:border-gray-900 transition-all hover:shadow-lg"
            >
              <div className="aspect-video overflow-hidden bg-gray-100">
                <img src={w.img} alt={w.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
              </div>
              <div className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-emerald-600 uppercase tracking-wider">{w.tag}</span>
                  <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-gray-900 transition" />
                </div>
                <h3 className="font-bold text-lg mb-1">{w.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{w.desc}</p>
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}
