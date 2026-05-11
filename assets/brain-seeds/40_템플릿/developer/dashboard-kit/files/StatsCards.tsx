import { TrendingUp, TrendingDown, DollarSign, Users, ShoppingBag, Activity } from 'lucide-react'

const stats = [
  { Icon: DollarSign, label: '월 매출', value: '$12,450', diff: '+12.5%', up: true },
  { Icon: Users,      label: '활성 사용자', value: '2,840', diff: '+8.2%', up: true },
  { Icon: ShoppingBag, label: '주문 수', value: '147', diff: '-3.1%', up: false },
  { Icon: Activity,   label: '전환율',   value: '4.8%',  diff: '+0.6%', up: true },
]

export default function StatsCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {stats.map(s => {
        const Icon = s.Icon
        const Diff = s.up ? TrendingUp : TrendingDown
        return (
          <div key={s.label} className="bg-white border border-gray-200 rounded-2xl p-5 hover:shadow-sm transition">
            <div className="flex items-center justify-between mb-3">
              <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center">
                <Icon className="w-4 h-4 text-gray-700" />
              </div>
              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded ${s.up ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50'}`}>
                <Diff className="w-3 h-3" />
                {s.diff}
              </span>
            </div>
            <p className="text-sm text-gray-500 mb-1">{s.label}</p>
            <p className="text-2xl font-bold tracking-tight">{s.value}</p>
          </div>
        )
      })}
    </div>
  )
}
