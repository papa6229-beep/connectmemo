import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

const faqs = [
  {
    q: '진짜 100% 무료인가요?',
    a: '네. 로컬 LLM 사용 시 클라우드 토큰 비용 0원. Pro 플랜은 선택사항으로, 클라우드 동기화·프리미엄 템플릿이 필요할 때만 결제.',
  },
  {
    q: '데이터는 어디에 저장되나요?',
    a: '100% 사용자 컴퓨터. 두뇌 폴더(`~/.connect-ai-brain/`)에 마크다운으로 저장. GitHub 백업은 사용자가 직접 설정.',
  },
  {
    q: '어떤 하드웨어가 필요한가요?',
    a: '최소 8GB RAM (작은 모델용). 16GB RAM이면 권장 모델(qwen2.5-coder:14b)까지 가능. M1/M2 Mac에서 가장 빠름.',
  },
  {
    q: '구독 취소가 자유로운가요?',
    a: '네. Pro 플랜은 언제든 취소. 취소 후에도 무료 기능은 영구 사용 가능.',
  },
  {
    q: '비기술자도 쓸 수 있나요?',
    a: '네. 설치 마법사가 모델 자동 감지·다운로드. 회사 인터뷰 위저드가 사용자에게 5분 인터뷰 후 자동 셋업.',
  },
]

export default function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0)
  return (
    <section className="py-16 sm:py-24 px-6 bg-gray-50">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center mb-12">
          자주 묻는 질문
        </h2>
        <div className="space-y-3">
          {faqs.map((faq, i) => {
            const open = openIdx === i
            return (
              <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <button
                  onClick={() => setOpenIdx(open ? null : i)}
                  className="w-full text-left px-6 py-5 flex items-center justify-between gap-4 hover:bg-gray-50 transition"
                >
                  <span className="font-semibold text-gray-900">{faq.q}</span>
                  <ChevronDown
                    className={'w-5 h-5 text-gray-400 flex-shrink-0 transition-transform ' + (open ? 'rotate-180' : '')}
                  />
                </button>
                {open && (
                  <div className="px-6 pb-5 text-gray-600 leading-relaxed">{faq.a}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
