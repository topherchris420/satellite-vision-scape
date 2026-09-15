# Reconstruction from the supplied photographs

The facility layout is now traced from the supplied images instead of generic
context buildings. `src/lib/reference-layout.ts` preserves the original pixel
coordinates so every footprint and road can be checked against the source.

## References and what each establishes

- `CROP-Pine_Gap_Bing3-copy-1503072465(1).jpg`, 1424 × 852: primary plan-view
  reference for building roof outlines, road centre lines, visible boundary
  lines, garden trees, pool and northern ponds. Capture date is not established.
- `Figure-1.-Antenna-systems-at-Pine-Gap-Google-Earth-imagery-6-November-2015-annotated-16-February(1).webp`,
  745 × 827: antenna identification and cross-check of the northern row,
  western compound, central block and eastern campus arrangement.
- `Pine_Gap_by_Skyring(1).jpg`, 800 × 600: oblique visual reference for the
  low-rise white roofs, radome massing and the relationship between cleared
  ground and sparse surrounding vegetation. Its capture date is not established.

The photos show different coverage and some different structures. The Bing
footprints and existing February 2016 public antenna manifest form the working
composition; this is not represented as a single dated photogrammetric survey.
The southern 08-A installation visible beyond the Bing crop remains unmodelled.

## Calibration and accuracy

Six manually identified radome centres were fitted to the existing public
survey coordinate frame: 10-A, 68-A, 68-B, 90-B, 98-A and 13-B. The affine fit
has individual residuals of approximately 0.08–3.87 metres. These are control-point
residuals, not a guarantee of accuracy elsewhere. Image parallax, roof height,
centre-picking error and acquisition differences remain. Survey antenna positions
were retained, rather than moving them to eliminate image residuals.

Building rectangles approximate roof outlines; image shear is represented by
the centre, measured side lengths and rotation of each rigid box. Connected
roof sections are separate masses. Long shallow gables follow the narrow roof
strips. Heights are visual estimates of 2.4–8 m, not measurements. Invented
random rooftop equipment is disabled for traced buildings.

Trees mark visible crowns rather than an ecological inventory. The ponds are
visual water surfaces without inferred contents or infrastructure roles. The
landscape outside the image traces remains procedural, and no surveyed elevation
model or hidden/interior construction is claimed.

## Review

Press **4** or choose **Plan** for a north-up orthographic view, then drag to pan
or scroll to zoom. Explore, Ground and Tour remain available.

Run `node --import tsx scripts/reference-plan.ts` to regenerate
`docs/reference-plan.svg` from the same transformed building footprints and road
paths that the scene uses. An optional argument writes JSON for a coordinate
overlay against the source image. The reference photographs are not redistributed
with the repository. The SVG verifies layout only, not the final WebGL render.

Regression tests cover calibration residuals, coordinate round trips, building
centres, roof orientation, garden/parking separation and rooftop-radome support.
