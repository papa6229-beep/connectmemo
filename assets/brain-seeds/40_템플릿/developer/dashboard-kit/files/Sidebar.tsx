import { useState } from 'react'
import { Home, BarChart3, Users, Settings, ShoppingBag, FileText, LogOut } from 'lucide-react'

const menuItems = [
  { icon: Home, label: 'Overview', key: 'overview' },
  { icon: BarChart3, label: 'Analytics', key: 'analytics' },
  { icon: ShoppingBag, label: 'Orders', key: 'orders' },
  { icon: Users, label: 'Customers', key: 'customers' },
  { icon: FileText, label: 'Reports', key: 'reports' },
  { icon: Settings, label: 'Settings', key: 'settings' },
]

export default function Sidebar() {
  const [active, setActive] = useState('overview')
  return (
    <aside className="w-64 bg-slate-900 text-white flex flex-col flex-shrink-0">
      <div className="p-6 border-b border-slate-800">
        <h2 className="font-bold text-lg tracking-tight">
          {/* TODO: 회사·서비스명 */}
          Connect AI
        </h2>
        <p className="text-xs text-slate-400 mt-1">v2.89 · 1인 기업</p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {menuItems.map(item => {
          const Icon = item.icon
          const isActive = active === item.key
          return (
            <button
              key={item.key}
              onClick={() => setActive(item.key)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                isActive
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {item.label}
            </button>
          )
        })}
      </nav>
      <div className="p-3 border-t border-slate-800">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center text-sm font-bold">
            J
          </div>
          <div className="flex-1 min-w-0">
            {/* TODO: 사용자 이름·이메일 */}
            <p className="text-sm font-medium truncate">Jay Kim</p>
            <p className="text-xs text-slate-400 truncate">jay@example.com</p>
          </div>
          <button aria-label="logout" className="text-slate-400 hover:text-white">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
