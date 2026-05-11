import { View, Text, Image, ScrollView } from 'react-native'

const stats = [
  { label: '구독자', value: '111K' },
  { label: '월 매출', value: '$12.4K' },
  { label: '운영 일수', value: '847' },
]

export default function ProfileScreen() {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#F8FAFC' }}>
      <View style={{ alignItems: 'center', paddingTop: 32, paddingBottom: 24, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}>
        <Image
          source={{ uri: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=200&q=80' }}
          style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: '#E2E8F0', marginBottom: 14 }}
        />
        <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A', letterSpacing: -0.5 }}>
          {/* TODO: 본인 이름 */}
          Jay Kim
        </Text>
        <Text style={{ fontSize: 14, color: '#64748B', marginTop: 4 }}>
          {/* TODO: 한 줄 소개 */}
          AI 1인 기업 · Connect AI 창업
        </Text>
      </View>

      <View style={{ flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}>
        {stats.map((s, i) => (
          <View
            key={s.label}
            style={{
              flex: 1,
              paddingVertical: 18,
              alignItems: 'center',
              borderRightWidth: i < stats.length - 1 ? 1 : 0,
              borderRightColor: '#E2E8F0',
            }}
          >
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#0F172A' }}>{s.value}</Text>
            <Text style={{ fontSize: 11, color: '#64748B', marginTop: 4, letterSpacing: 0.5, textTransform: 'uppercase', fontWeight: '600' }}>
              {s.label}
            </Text>
          </View>
        ))}
      </View>

      <View style={{ padding: 16 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 10, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          이번 달
        </Text>
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 18, borderWidth: 1, borderColor: '#E2E8F0' }}>
          <Text style={{ fontSize: 15, color: '#0F172A', lineHeight: 22 }}>
            • 5월 영상 5편 업로드 · 평균 30K 조회{'\n'}
            • Connect AI v2.89.121 출시 · 122 예정{'\n'}
            • EZER AI Pack Vault 3-channel 시스템 완성{'\n'}
            • 매트릭스 톤 + 우와 모먼트 7종 인터랙션
          </Text>
        </View>
      </View>
    </ScrollView>
  )
}
