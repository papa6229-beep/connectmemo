const rows = [
  { id: '#1024', name: '이지은', plan: 'Pro',   amount: '$49.00', status: '결제완료', ts: '2시간 전' },
  { id: '#1023', name: '박민수', plan: 'Free',  amount: '—',      status: '신규가입', ts: '4시간 전' },
  { id: '#1022', name: '김서연', plan: 'Team',  amount: '$199.00', status: '결제완료', ts: '5시간 전' },
  { id: '#1021', name: '정현우', plan: 'Pro',   amount: '$49.00', status: '환불',     ts: '7시간 전' },
  { id: '#1020', name: '최아람', plan: 'Pro',   amount: '$49.00', status: '결제대기', ts: '8시간 전' },
]

const statusStyle: Record<string, string> = {
  '결제완료': 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  '결제대기': 'bg-amber-50 text-amber-700 ring-amber-200',
  '신규가입': 'bg-blue-50 text-blue-700 ring-blue-200',
  '환불':     'bg-red-50 text-red-700 ring-red-200',
}

export default function RecentTable() {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="p-5 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="font-bold">최근 활동</h3>
          <p className="text-xs text-gray-500 mt-0.5">실시간 업데이트</p>
        </div>
        <button className="text-sm text-gray-600 hover:text-gray-900 transition">
          모두 보기 →
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-5 py-3 font-semibold">주문</th>
              <th className="text-left px-5 py-3 font-semibold">고객</th>
              <th className="text-left px-5 py-3 font-semibold">플랜</th>
              <th className="text-left px-5 py-3 font-semibold">금액</th>
              <th className="text-left px-5 py-3 font-semibold">상태</th>
              <th className="text-right px-5 py-3 font-semibold">시각</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50 transition">
                <td className="px-5 py-4 font-mono text-xs text-gray-500">{r.id}</td>
                <td className="px-5 py-4 font-medium">{r.name}</td>
                <td className="px-5 py-4 text-gray-600">{r.plan}</td>
                <td className="px-5 py-4 font-medium">{r.amount}</td>
                <td className="px-5 py-4">
                  <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold ring-1 ${statusStyle[r.status] || 'bg-gray-50 text-gray-600 ring-gray-200'}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-5 py-4 text-right text-gray-500 text-xs">{r.ts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
