import type {
  VenueLightingEvent,
  VenuePostProcessingEvent,
  VenueStageEvent,
  VenueCameraCutEvent,
  VenuePerformerEvent
} from '../../types'

export type VenuePerformerTarget = 'guitar' | 'bass' | 'drums' | 'vocals' | 'keys' | 'all' | 'crowd' | 'other'

export type VenueLightingSemantic = {
  rawType: string
  mood: 'neutral' | 'blackout' | 'strobe' | 'warm' | 'cool'
}

export type VenuePostProcessingSemantic = {
  rawType: string
  effect: 'none' | 'bloom' | 'negative' | 'sepia' | 'desaturate' | 'posterize' | 'security_cam'
}

export type VenueStageSemantic = {
  rawEffect: string
  effect: 'fog_on' | 'fog_off' | 'bonus_fx' | 'sequence' | 'other'
}

export type VenueCameraSemantic = {
  rawSubject: string
  target: VenuePerformerTarget
  framing: 'default' | 'wide' | 'near' | 'closeup'
}

export type VenuePerformerSemantic = {
  rawType: string
  rawPerformer: string | null
  cue: 'spotlight' | 'singalong' | 'other'
  target: VenuePerformerTarget
}

function normalizeText(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase()
}

function performerTargetFromText(value: string): VenuePerformerTarget {
  if (value.includes('guitar')) return 'guitar'
  if (value.includes('bass')) return 'bass'
  if (value.includes('drum')) return 'drums'
  if (value.includes('vocal')) return 'vocals'
  if (value.includes('keys')) return 'keys'
  if (value.includes('crowd') || value.includes('stagedive') || value.includes('crowdsurf')) return 'crowd'
  if (value.includes('all') || value.includes('front')) return 'all'
  return 'other'
}

export function normalizeVenueLightingEvent(event: VenueLightingEvent | null): VenueLightingSemantic | null {
  if (!event) return null
  const rawType = event.type
  const cue = normalizeText(event.type)

  let mood: VenueLightingSemantic['mood'] = 'neutral'
  if (cue.includes('blackout')) mood = 'blackout'
  else if (cue.includes('strobe')) mood = 'strobe'
  else if (cue.includes('warm') || cue.includes('flare')) mood = 'warm'
  else if (cue.includes('cool') || cue.includes('search')) mood = 'cool'

  return { rawType, mood }
}

export function normalizeVenuePostProcessingEvent(event: VenuePostProcessingEvent | null): VenuePostProcessingSemantic | null {
  if (!event) return null
  const rawType = event.type
  const effectName = normalizeText(event.type)

  let effect: VenuePostProcessingSemantic['effect'] = 'none'
  if (effectName.includes('bloom') || effectName.includes('bright')) effect = 'bloom'
  else if (effectName.includes('negative')) effect = 'negative'
  else if (effectName.includes('sepia')) effect = 'sepia'
  else if (effectName.includes('bw') || effectName.includes('desat')) effect = 'desaturate'
  else if (effectName.includes('posterize') || effectName.includes('photocopy')) effect = 'posterize'
  else if (effectName.includes('security') || effectName.includes('shitty_tv')) effect = 'security_cam'

  return { rawType, effect }
}

export function normalizeVenueStageEvent(event: VenueStageEvent): VenueStageSemantic {
  const rawEffect = event.effect
  const effectName = normalizeText(event.effect)

  let effect: VenueStageSemantic['effect'] = 'other'
  if (effectName.includes('fogon')) effect = 'fog_on'
  else if (effectName.includes('fogoff')) effect = 'fog_off'
  else if (effectName.includes('bonusfx')) effect = 'bonus_fx'
  else if (effectName === 'first' || effectName === 'next' || effectName === 'prev') effect = 'sequence'

  return { rawEffect, effect }
}

export function normalizeVenueCameraCutEvent(event: VenueCameraCutEvent | null): VenueCameraSemantic | null {
  if (!event) return null
  const rawSubject = event.subject
  const subject = normalizeText(event.subject)
  const target = performerTargetFromText(subject)

  let framing: VenueCameraSemantic['framing'] = 'default'
  if (subject.includes('all_far') || subject.includes('behind')) framing = 'wide'
  else if (subject.includes('all_near') || subject.includes('_near') || subject.includes('_np')) framing = 'near'
  else if (subject.includes('closeup') || subject.includes('_cls') || subject.includes('_cam')) framing = 'closeup'

  return { rawSubject, target, framing }
}

export function normalizeVenuePerformerEvent(event: VenuePerformerEvent): VenuePerformerSemantic {
  const rawType = event.type
  const rawPerformer = event.performer ?? null
  const typeName = normalizeText(event.type)
  const performerName = normalizeText(event.performer)

  let cue: VenuePerformerSemantic['cue'] = 'other'
  if (typeName.includes('spot')) cue = 'spotlight'
  else if (typeName.includes('sing')) cue = 'singalong'

  const target = performerName ? performerTargetFromText(performerName) : performerTargetFromText(typeName)

  return { rawType, rawPerformer, cue, target }
}

export function getVenuePerformerTargetLabel(target: VenuePerformerTarget): string {
  switch (target) {
    case 'guitar': return 'Guitar'
    case 'bass': return 'Bass'
    case 'drums': return 'Drums'
    case 'vocals': return 'Vocals'
    case 'keys': return 'Keys'
    case 'all': return 'All'
    case 'crowd': return 'Crowd'
    default: return 'Other'
  }
}