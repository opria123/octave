# Third-Party Notices

OCTAVE's own source code is released under the [MIT License](LICENSE). Some
bundled assets come from other projects and keep their original licenses. This
file lists them. The license texts are included in the repository and shipped
inside the packaged app next to the assets they cover.

## YARG highway assets (LGPL-3.0-or-later)

The 3D highway preview uses note models, fret models and textures copied
unmodified from [YARG](https://github.com/YARC-Official/YARG), Copyright (c)
YARC and the YARG contributors, licensed under the
[GNU Lesser General Public License v3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.html).

| Where in this repo | What | License |
|---|---|---|
| `src/renderer/public/highway-assets/models/*.fbx` (12 files) | Note and fret meshes | LGPL-3.0-or-later |
| `src/renderer/public/highway-assets/textures/*.png` (8 files) | Note, fret and track textures | LGPL-3.0-or-later |

The exact upstream path of every file is listed in
[`src/renderer/public/highway-assets/ASSET-LICENSES.txt`](src/renderer/public/highway-assets/ASSET-LICENSES.txt).
The full license texts are in
[`LICENSE.LGPL-3.0.txt`](src/renderer/public/highway-assets/LICENSE.LGPL-3.0.txt) and
[`LICENSE.GPL-3.0.txt`](src/renderer/public/highway-assets/LICENSE.GPL-3.0.txt)
in the same folder.

Parts of the preview renderer in `src/renderer/src/components/chartPreviewModules/`
(notably `constants.ts`, `Highway.tsx`, `Strikeline.tsx` and `BeatGrid.tsx`)
reproduce layout values, colours and visual behaviour from YARG's
`TrackPlayer.cs`, `FretArray.cs`, `GenericTrackPlayer.cs`, `Track.shadergraph`
and `RectangularFret.prefab` so that the preview matches the game.

These assets are separate files loaded at runtime and can be swapped for your
own. Using them does not change the license of OCTAVE's own code, but anyone
redistributing OCTAVE must keep the notices and license texts above with the
assets, and modified versions of the assets must stay under LGPL-3.0-or-later.

## Venue sample models

The default and sample venue models under `src/renderer/public/highway-assets/venue/`
come from the Khronos glTF Sample Assets and Google model-viewer shared assets
(Apache-2.0 and CC-BY-4.0). See the `ASSET-LICENSES.txt` in each venue folder.
