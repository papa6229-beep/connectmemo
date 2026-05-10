import { Check } from 'lucide-react'

const plans = [
  {
    name: '무료',
    price: '₩0',
    period: '/영원히',
    desc: '시작하기',
    features: ['9명 AI 에이전트', '로컬 LLM 자동 연결', '두뇌 무제한', '커뮤니티 지원'],
    cta: '지금 다운로드',
    href: '#',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '₩9,900',
    period: '/월',
    desc: '진지하게 1인 기업 운영',
    features: [
      '무료 플랜 전부',
      '클라우드 두뇌 동기화',
      '프리미엄 템플릿',
      '우선 지원 (24h 응답)',
      '신규 기능 우선 접근',
    ],
    cta: '14일 무료 체험',
    href: '#',
    highlighted: true,
  },
  {
    name: '팀',
    price: '문의',
    period: '',
    desc: '여러 명이 함께',
    features: ['Pro 전부', '팀 공용 두뇌', 'SSO', '맞춤 페르소나'],
    cta: '상담 신청',
    href: '#',
    highlighted: false,
  },
]

export default function Pricing() {
  return (
    <section id="pricing" className="py-16 sm:py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 mb-4">
            요금
          </h2>
          <p className="text-lg text-gray-600">
            {/* TODO: 가격 부담 낮추는 메시지 */}
            무료로 시작. 언제든 업그레이드.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={
                'rounded-2xl p-8 border ' +
                (plan.highlighted
                  ? 'bg-gray-900 text-white border-gray-900 shadow-2xl scale-105'
                  : 'bg-white text-gray-900 border-gray-200')
              }
            >
              <h3 className="text-lg font-semibold mb-1">{plan.name}</h3>
              <p className={'text-sm mb-6 ' + (plan.highlighted ? 'text-gray-400' : 'text-gray-500')}>
                {plan.desc}
              </p>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-4xl font-bold">{plan.price}</span>
                <span className={'text-sm ' + (plan.highlighted ? 'text-gray-400' : 'text-gray-500')}>
                  {plan.period}
                </span>
              </div>
              <ul className="space-y-3 mb-8">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <a
                href={plan.href}
                className={
                  'block w-full text-center py-3 rounded-xl font-semibold transition-all ' +
                  (plan.highlighted
                    ? 'bg-white text-gray-900 hover:bg-gray-100'
                    : 'bg-gray-900 text-white hover:bg-gray-800')
                }
              >
                {plan.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
