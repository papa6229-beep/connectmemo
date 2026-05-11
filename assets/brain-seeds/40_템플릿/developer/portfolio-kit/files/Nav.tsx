import { useState, useEffect } from 'react'

export default function Nav() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <nav className={`fixed top-0 inset-x-0 z-50 transition-all ${scrolled ? 'bg-white/90 backdrop-blur border-b border-gray-200 py-3' : 'bg-transparent py-5'}`}>
      <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
        <a href="#" className="font-bold text-lg tracking-tight">
          {/* TODO: 본인 이름 또는 로고 */}
          Jay Kim
        </a>
        <div className="hidden sm:flex items-center gap-8 text-sm">
          <a href="#about" className="hover:text-emerald-600 transition">About</a>
          <a href="#work" className="hover:text-emerald-600 transition">Work</a>
          <a href="#skills" className="hover:text-emerald-600 transition">Skills</a>
          <a href="#contact" className="bg-gray-900 text-white px-4 py-2 rounded-lg hover:bg-gray-800 transition">
            Contact
          </a>
        </div>
      </div>
    </nav>
  )
}
