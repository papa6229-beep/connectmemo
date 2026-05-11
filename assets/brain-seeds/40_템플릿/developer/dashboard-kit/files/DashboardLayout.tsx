import Sidebar from './Sidebar'
import Topbar from './Topbar'
import StatsCards from './StatsCards'
import RecentTable from './RecentTable'

export default function DashboardLayout() {
  return (
    <div className="flex min-h-screen bg-gray-50 text-gray-900">
      <Sidebar />
      <main className="flex-1 flex flex-col">
        <Topbar />
        <div className="flex-1 p-6 sm:p-8 overflow-auto">
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-sm text-gray-500 mt-1">
              {/* TODO: 대시보드 한 줄 설명 */}
              내 비즈니스 한눈에 보기
            </p>
          </div>
          <StatsCards />
          <RecentTable />
        </div>
      </main>
    </div>
  )
}
