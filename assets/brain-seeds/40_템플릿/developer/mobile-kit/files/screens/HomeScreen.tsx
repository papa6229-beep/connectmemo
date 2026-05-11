import { ScrollView, View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

const items = [
  { id: '1', emoji: '🎯', title: '오늘 목표', sub: 'AI 1인 기업 콘텐츠 1개 작성', accent: '#10B981' },
  { id: '2', emoji: '📊', title: '이번 주 매출', sub: '$2,840 · 평균 +20%', accent: '#3B82F6' },
  { id: '3', emoji: '🚀', title: '런칭 D-7', sub: 'Connect AI v3.0 출시 준비', accent: '#F59E0B' },
  { id: '4', emoji: '💌', title: '오늘 답변할 이메일', sub: '4건 대기 중', accent: '#EF4444' },
]

export default function HomeScreen() {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#F8FAFC' }} contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <View style={{ marginBottom: 20 }}>
        <Text style={{ fontSize: 13, color: '#64748B', fontWeight: '600', letterSpacing: 0.5 }}>
          {/* TODO: 오늘 날짜·인사 */}
          2026년 5월 11일 · 일요일
        </Text>
        <Text style={{ fontSize: 26, fontWeight: '800', color: '#0F172A', marginTop: 4, letterSpacing: -0.5 }}>
          좋은 아침이에요 👋
        </Text>
      </View>

      {items.map(item => (
        <Pressable
          key={item.id}
          style={({ pressed }) => ({
            backgroundColor: '#fff',
            borderRadius: 16,
            padding: 18,
            marginBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            borderWidth: 1,
            borderColor: '#E2E8F0',
            transform: [{ scale: pressed ? 0.98 : 1 }],
          })}
        >
          <View style={{
            width: 48, height: 48, borderRadius: 12,
            backgroundColor: item.accent + '15',
            justifyContent: 'center', alignItems: 'center', marginRight: 14,
          }}>
            <Text style={{ fontSize: 24 }}>{item.emoji}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '700', fontSize: 15, color: '#0F172A', marginBottom: 3 }}>
              {item.title}
            </Text>
            <Text style={{ fontSize: 13, color: '#64748B' }}>{item.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#CBD5E1" />
        </Pressable>
      ))}

      <Pressable
        style={({ pressed }) => ({
          backgroundColor: '#0F172A',
          borderRadius: 16,
          padding: 18,
          marginTop: 12,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ scale: pressed ? 0.98 : 1 }],
        })}
      >
        <Ionicons name="add-circle-outline" size={20} color="#10B981" />
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15, marginLeft: 8 }}>
          오늘 할 일 추가
        </Text>
      </Pressable>
    </ScrollView>
  )
}
