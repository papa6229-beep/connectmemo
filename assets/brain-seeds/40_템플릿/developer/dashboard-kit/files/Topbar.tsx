import { Search, Bell } from 'lucide-react'

export default function Topbar() {
  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center px-6 sm:px-8 gap-4">
      <div className="flex-1 max-w-xl relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="search"
          placeholder="검색..."
          className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:border-gray-900 transition"
        />
      </div>
      <button aria-label="notifications" className="relative p-2 hover:bg-gray-100 rounded-lg transition">
        <Bell className="w-5 h-5 text-gray-600" />
        <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-emerald-500 rounded-full" />
      </button>
      <div className="w-9 h-9 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold">
        J
      </div>
    </header>
  )
}
