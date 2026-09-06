---
layout: page
title: OCTAVE
titleTemplate: ':title - Chart editor & auto-charter for rhythm games'
---

<section class="octave-hero">
  <div class="octave-hero-glow"></div>
  <div class="octave-hero-inner">
    <div class="octave-hero-eyebrow">
      <span class="octave-eyebrow-dot"></span>
      Chart editor &amp; auto-charter for rhythm games
    </div>
    <h1 class="octave-hero-title">OCTAVE</h1>
    <p class="octave-hero-pitch">
      Build the charts you want.<br>
      <span class="octave-hero-pitch-accent">Edit, preview, and play.</span>
    </p>
    <p class="octave-hero-sub">
      Edit rhythm-game charts on a piano roll with a live 3D preview.
      Use compatible STRUM profiles for local generation, or train candidates
      from an explicitly approved chart library.
    </p>
    <div class="octave-hero-actions">
      <a class="octave-btn octave-btn-primary" href="https://github.com/opria123/octave/releases/latest">
        <span>Download for Windows, macOS, Linux</span>
      </a>
      <a class="octave-btn octave-btn-ghost" href="/guide/getting-started">Get started</a>
      <a class="octave-btn octave-btn-ghost" href="https://github.com/opria123/octave">GitHub</a>
    </div>
    <div class="octave-hero-meta">
      <span><span class="octave-dot"></span>Local chart editing and training.</span>
      <span><span class="octave-dot"></span>MIT licensed.</span>
      <span><span class="octave-dot"></span>Reads &amp; writes <code>.mid</code> and <code>.chart</code>.</span>
    </div>
  </div>
  <div class="octave-promo-frame">
    <div class="octave-promo-aspect">
      <video
        class="octave-promo-video"
        src="/octave-promo.mp4"
        preload="auto"
        muted
        autoplay
        loop
        playsinline
      ></video>
    </div>
  </div>
</section>

<section class="octave-section octave-headline-strum">
  <div class="octave-headline-strum-inner">
    <div class="octave-headline-strum-eyebrow">The big one</div>
    <h2 class="octave-headline-strum-title">
      Train, evaluate,
      <span class="octave-grad">then choose your profile.</span>
    </h2>
    <p class="octave-headline-strum-body">
      <strong>STRUM</strong> runs locally through a selected compatible runtime.
      OCTAVE curates approved sources, supervises training, and lets you select
      profiles that pass their evaluation and packaging gates. Instruments,
      inputs, and difficulties depend on the profile; raw candidates stay
      separate from deployable models.
    </p>
    <div class="octave-headline-strum-actions">
      <a class="octave-btn octave-btn-primary" href="/guide/strum-training">Train with your library</a>
      <a class="octave-btn octave-btn-ghost" href="/guide/auto-chart">Use a chart profile</a>
      <a class="octave-btn octave-btn-ghost" href="https://github.com/opria123/strum">STRUM on GitHub</a>
    </div>
  </div>
</section>

<section class="octave-section">
  <div class="octave-section-head">
    <div class="octave-section-eyebrow">Features</div>
    <h2 class="octave-section-title">Everything you need to chart, nothing you don't.</h2>
  </div>
  <div class="octave-feature-grid">
    <a class="octave-feature" href="/guide/auto-chart">
      <div class="octave-feature-icon"><img src="/icons/feature-strum.svg" alt=""></div>
      <div class="octave-feature-title">Profile-based generation</div>
      <p>Select a validated audio profile, or transform an Expert MIDI chart with a learned difficulty profile. Review the result before release.</p>
      <div class="octave-feature-cta">Auto-Chart guide <span>&rarr;</span></div>
    </a>
    <a class="octave-feature" href="/guide/midi-editor">
      <div class="octave-feature-icon"><img src="/icons/feature-instruments.svg" alt=""></div>
      <div class="octave-feature-title">Multi-instrument chart editing</div>
      <p>Pro Drums, 5-fret guitar / bass / keys, 25-key Pro Keys, 6-string Pro Guitar / Bass, and pitched vocals.</p>
      <div class="octave-feature-cta">MIDI editor <span>&rarr;</span></div>
    </a>
    <a class="octave-feature" href="/guide/chart-preview">
      <div class="octave-feature-icon"><img src="/icons/feature-highway.svg" alt=""></div>
      <div class="octave-feature-title">A 3D preview that matches the game</div>
      <p>A 3D highway preview with hit effects, sustains, star power, and animated venues. WYSIWYG charting.</p>
      <div class="octave-feature-cta">Chart preview <span>&rarr;</span></div>
    </a>
    <a class="octave-feature" href="/guide/timeline-editor">
      <div class="octave-feature-icon"><img src="/icons/feature-venue.svg" alt=""></div>
      <div class="octave-feature-title">Venue and timeline editor</div>
      <p>Real lighting cues, post-fx, camera cuts, performer events, and stage effects on the same timeline as your notes.</p>
      <div class="octave-feature-cta">Timeline editor <span>&rarr;</span></div>
    </a>
    <a class="octave-feature" href="/reference/file-formats">
      <div class="octave-feature-icon"><img src="/icons/feature-formats.svg" alt=""></div>
      <div class="octave-feature-title">Speaks .mid and .chart</div>
      <p>Round-trip <code>.mid</code> and <code>.chart</code> formats without losing tempo maps, sections, lyrics, or instrument metadata.</p>
      <div class="octave-feature-cta">File formats <span>&rarr;</span></div>
    </a>
    <a class="octave-feature" href="/guide/stems-mixer">
      <div class="octave-feature-icon"><img src="/icons/feature-stems.svg" alt=""></div>
      <div class="octave-feature-title">DAW-style stems mixer</div>
      <p>Per-stem volume, mute, and exclusive solo while playing back. Auto-loads every stem in the song folder.</p>
      <div class="octave-feature-cta">Stems mixer <span>&rarr;</span></div>
    </a>
  </div>
</section>

<section class="octave-section">
  <div class="octave-section-head">
    <div class="octave-section-eyebrow">How it works</div>
    <h2 class="octave-section-title">From source chart to reviewed output.</h2>
  </div>
  <div class="octave-steps">
    <div class="octave-step">
      <div class="octave-step-num">01</div>
      <div class="octave-step-title">Open a chart or select a profile</div>
      <p>Import a chart for editing, or use a compatible STRUM profile with its required audio or source MIDI input.</p>
    </div>
    <div class="octave-step">
      <div class="octave-step-num">02</div>
      <div class="octave-step-title">Edit on a real piano roll</div>
      <p>Tweak notes, sustains, sections, lyrics, and venue cues. The 3D preview updates live above the timeline.</p>
    </div>
    <div class="octave-step">
      <div class="octave-step-num">03</div>
      <div class="octave-step-title">Export and play</div>
      <p>Save as <code>.mid</code> or <code>.chart</code>, drop into your songs folder, launch the game.</p>
    </div>
  </div>
</section>

<section class="octave-section">
  <div class="octave-section-head">
    <div class="octave-section-eyebrow">By the numbers</div>
    <h2 class="octave-section-title">Built for the long charting nights.</h2>
  </div>
  <div class="octave-stats">
    <div class="octave-stat">
      <div class="octave-stat-value">8</div>
      <div class="octave-stat-label">Instrument editors</div>
    </div>
    <div class="octave-stat">
      <div class="octave-stat-value">4</div>
      <div class="octave-stat-label">Editable difficulty levels</div>
    </div>
    <div class="octave-stat">
      <div class="octave-stat-value">2</div>
      <div class="octave-stat-label">Formats round-tripped</div>
    </div>
    <div class="octave-stat">
      <div class="octave-stat-value">Local</div>
      <div class="octave-stat-label">Editing and training</div>
    </div>
  </div>
</section>

<section class="octave-section">
  <div class="octave-section-head">
    <div class="octave-section-eyebrow">Under the hood</div>
    <h2 class="octave-section-title">Built on the open stack you already trust.</h2>
  </div>
  <div class="octave-pill-row octave-pill-row-tech">
    <span class="octave-pill"><strong>Electron</strong></span>
    <span class="octave-pill"><strong>React 19</strong></span>
    <span class="octave-pill"><strong>Three.js</strong></span>
    <span class="octave-pill"><strong>basic-pitch</strong></span>
    <span class="octave-pill"><strong>Demucs</strong></span>
    <span class="octave-pill"><strong>whisper.cpp</strong></span>
    <span class="octave-pill"><strong>VitePress</strong> docs</span>
  </div>
</section>

<section class="octave-section octave-cta">
  <h2 class="octave-cta-title">Ready to chart?</h2>
  <p class="octave-cta-sub">Grab the latest build, or read the five-minute getting-started guide.</p>
  <div class="octave-cta-actions">
    <a class="octave-btn octave-btn-primary" href="https://github.com/opria123/octave/releases/latest">Download OCTAVE</a>
    <a class="octave-btn octave-btn-ghost" href="/guide/getting-started">Get started</a>
  </div>
</section>
