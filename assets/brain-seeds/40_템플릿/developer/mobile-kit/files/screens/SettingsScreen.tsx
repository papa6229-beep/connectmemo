import { useState } from 'react'
import { ScrollView, View, Text, Switch, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function SettingsScreen() {
  const [push, setPush] = useState(true)
  const [analytics, setAnalytics] = useState(false)
  const [darkMode, setDarkMode] = useState(false)

  const menuItems = [
    { icon: 'person-outline' as const, label: '계정', sub: 'hello@example.com' },
    { icon: 'card-outline' as const, label: '결제 수단', sub: 'Visa ••• 4242' },
    { icon: 'shield-checkmark-outline' as const, label: '개인정보 보호', sub: '데이터 100% 로컬' },
    { icon: 'help-circle-outline' as const, label: '도움말', sub: 'FAQ · 가이드' },
  ]

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#F8FAFC' }} contentContainerStyle={{ paddingVertical: 12 }}>
      <Section title="알림">
        <Toggle
          icon="notifications-outline"
          label="푸시 알림"
          sub="새 활동·답변·승인 요청"
          value={push}
          onChange={setPush}
        />
        <Toggle
          icon="stats-chart-outline"
          label="분석 공유"
          sub="익명 사용 통계 (개선용)"
          value={analytics}
          onChange={setAnalytics}
        />
      </Section>

      <Section title="화면">
        <Toggle
          icon="moon-outline"
          label="다크 모드"
          sub="시스템 설정 따라감"
          value={darkMode}
          onChange={setDarkMode}
        />
      </Section>

      <Section title="계정 관리">
        {menuItems.map(m => (
          <MenuRow key={m.label} icon={m.icon} label={m.label} sub={m.sub} />
        ))}
      </Section>

      <Pressable
        style={({ pressed }) => ({
          margin: 16,
          padding: 14,
          backgroundColor: pressed ? '#FEE2E2' : '#FEF2F2',
          borderRadius: 12,
          alignItems: 'center',
        })}
      >
        <Text style={{ color: '#DC2626', fontWeight: '700', fontSize: 14 }}>로그아웃</Text>
      </Pressable>
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 18 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', color: '#64748B', paddingHorizontal: 18, paddingBottom: 8, letterSpacing: 0.8, textTransform: 'uppercase' }}>
        {title}
      </Text>
      <View style={{ backgroundColor: '#fff', marginHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: '#E2E8F0', overflow: 'hidden' }}>
        {children}
      </View>
    </View>
  )
}

function Toggle({ icon, label, sub, value, onChange }: {
  icon: any; label: string; sub: string; value: boolean; onChange: (v: boolean) => void
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' }}>
      <Ionicons name={icon} size={20} color="#64748B" style={{ marginRight: 12 }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: '#0F172A' }}>{label}</Text>
        <Text style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{sub}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: '#CBD5E1', true: '#10B981' }}
        thumbColor="#fff"
      />
    </View>
  )
}

function MenuRow({ icon, label, sub }: { icon: any; label: string; sub: string }) {
  return (
    <Pressable
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center',
        padding: 14, borderBottomWidth: 1, borderBottomColor: '#F1F5F9',
        backgroundColor: pressed ? '#F8FAFC' : 'transparent',
      })}
    >
      <Ionicons name={icon} size={20} color="#64748B" style={{ marginRight: 12 }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: '#0F172A' }}>{label}</Text>
        <Text style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{sub}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
    </Pressable>
  )
}
