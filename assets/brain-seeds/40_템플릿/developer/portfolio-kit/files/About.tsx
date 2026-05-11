export default function About() {
  return (
    <section id="about" className="pt-32 sm:pt-40 pb-16 sm:pb-24 px-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-col md:flex-row items-start gap-10">
          <div className="flex-shrink-0">
            <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-2xl overflow-hidden ring-4 ring-gray-100">
              {/* TODO: 본인 사진으로 교체. Unsplash placeholder. */}
              <img
                src="https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400&q=80"
                alt="Profile"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-600 tracking-wider uppercase mb-3">
              Hello, I'm
            </p>
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
              {/* TODO: 본인 이름 */}
              Jay Kim
            </h1>
            <p className="text-xl text-gray-600 mb-6 leading-relaxed">
              {/* TODO: 한 줄 가치 제안 — [직업] · [도와주는 사람] · [결과] */}
              AI 1인 기업가의 두뇌를 디자인합니다. 10년차 풀스택 + AI 자동화 컨설팅.
            </p>
            <div className="flex flex-wrap gap-2">
              {/* TODO: 핵심 태그 3~5개 */}
              {['AI 자동화', '풀스택', '제2의 두뇌', 'YouTube'].map(tag => (
                <span key={tag} className="px-3 py-1 bg-gray-100 text-gray-700 text-sm rounded-full">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
