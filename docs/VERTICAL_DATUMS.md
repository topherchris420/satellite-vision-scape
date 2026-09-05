# Vertical datums

GeoTwn stores every elevation as `ReferencedHeight`: value, metre unit, vertical datum, source, transform method, geoid model, and optional uncertainty. Supported datums are EGM2008 orthometric, WGS84 ellipsoid, local synthetic, and unknown.

The conversion is explicit:

```text
h (WGS84 ellipsoidal) = H (EGM2008 orthometric) + N (EGM2008 geoid undulation)
H = h - N
```

Conversions reject the wrong input datum and non-finite values. `UNKNOWN` and `LOCAL_SYNTHETIC` cannot be converted. EGM2008 is a model, not a magic accuracy improvement: the source DEM error, interpolation error, geoid-model error, and horizontal registration still apply. Earthquake depth is semantically separate from terrain elevation even where encoded in a referenced altitude field.
