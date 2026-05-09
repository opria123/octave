<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

type Platform = 'win' | 'mac' | 'linux' | 'unknown'

const REPO_OWNER = 'opria123'
const REPO_NAME = 'octave'

const platform = ref<Platform>('unknown')
const assetUrl = ref<string | null>(null)
const version = ref<string>('')
const loading = ref(true)

const fallbackUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'mac'
  if (ua.includes('linux') && !ua.includes('android')) return 'linux'
  if (ua.includes('win')) return 'win'
  return 'unknown'
}

const PLATFORM_MATCHERS: Record<Exclude<Platform, 'unknown'>, RegExp> = {
  win: /setup\.exe$/i,
  mac: /\.dmg$/i,
  linux: /\.AppImage$/i
}

onMounted(async () => {
  platform.value = detectPlatform()
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`)
    if (!res.ok) {
      loading.value = false
      return
    }
    const data = await res.json()
    version.value = data.tag_name || ''
    const assets: Array<{ name: string; browser_download_url: string }> = data.assets || []
    if (platform.value !== 'unknown') {
      const re = PLATFORM_MATCHERS[platform.value]
      const asset = assets.find((a) => re.test(a.name))
      if (asset) assetUrl.value = asset.browser_download_url
    }
  } catch {
    // Network/API failure — fall back to releases page link.
  } finally {
    loading.value = false
  }
})

const platformLabel = computed(() => {
  switch (platform.value) {
    case 'win': return 'Windows'
    case 'mac': return 'macOS'
    case 'linux': return 'Linux'
    default: return 'Your Platform'
  }
})

const primaryHref = computed(() => assetUrl.value ?? fallbackUrl)
</script>

<template>
  <div class="dl-wrap">
    <a class="dl-primary" :href="primaryHref" :rel="assetUrl ? 'noopener' : 'noopener'">
      <span class="dl-icon" aria-hidden="true">⬇</span>
      <span class="dl-text">
        Download for {{ platformLabel }}
        <span v-if="version" class="dl-version">{{ version }}</span>
      </span>
    </a>
    <a class="dl-secondary" :href="fallbackUrl">All downloads &amp; release notes →</a>
  </div>
</template>

<style scoped>
.dl-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin: 24px 0 8px;
}

.dl-primary {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 14px 28px;
  font-size: 17px;
  font-weight: 700;
  color: #1a1208;
  background: linear-gradient(120deg, #f2a65a, #ffb56f 55%, #41c6b8);
  border-radius: 999px;
  text-decoration: none;
  box-shadow: 0 8px 24px rgba(242, 166, 90, 0.28);
  transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
}

.dl-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 28px rgba(242, 166, 90, 0.38);
  filter: brightness(1.04);
  text-decoration: none;
}

.dl-icon {
  font-size: 18px;
  line-height: 1;
}

.dl-text {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}

.dl-version {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
  font-family: var(--vp-font-family-mono);
}

.dl-secondary {
  font-size: 13px;
  opacity: 0.75;
  text-decoration: none;
}

.dl-secondary:hover {
  opacity: 1;
  text-decoration: underline;
}
</style>
