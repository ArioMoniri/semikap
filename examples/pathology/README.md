# Pathology sample data

TAMIAS does not ship whole-slide images, synthetic slides or placeholder
models. Real WSIs are large, so pick one from the public sources below
and open it in **Pathology** mode (Microscope toggle in the header).

This folder holds only `tissue_mask.json`, a **reference manifest**
(template) that exercises every field of the pathology manifest schema.
It has no model of its own — pair it with a real ONNX export (see the
last section).

## Public-domain WSIs that work in TAMIAS today

| Source                                                                                                          | License           | What you get                                                  |
|-----------------------------------------------------------------------------------------------------------------|-------------------|---------------------------------------------------------------|
| [CAMELYON16](https://camelyon16.grand-challenge.org/Data/)                                                      | CC0               | Sentinel-lymph-node H&E TIFFs (Aperio SVS — convert to OME-TIFF first) |
| [PANDA — Prostate cANcer graDe Assessment](https://www.kaggle.com/competitions/prostate-cancer-grade-assessment) | CC BY-SA 4.0      | TIFF tiles of biopsy cores                                    |
| [TCGA whole-slide images](https://portal.gdc.cancer.gov/)                                                       | NIH data-use cert | SVS — convert to OME-TIFF                                     |
| [HuBMAP human reference atlas](https://portal.hubmapconsortium.org/search?entity_type%5B0%5D=Dataset)           | CC BY 4.0         | OME-TIFF (load directly)                                      |

> The CAMELYON16 / TCGA / PANDA datasets are released for research use only
> and may carry additional citation or registration requirements. Check
> each dataset's terms before publishing derived results.

## Converting SVS / NDPI to OME-TIFF

`v0.6.0` does not yet ship OpenSlide-WASM, so vendor-format slides
(Aperio SVS, Hamamatsu NDPI) need an offline conversion. Two options:

**bioformats2raw + raw2ometiff** (recommended for whole TCGA cohorts):

```sh
bioformats2raw input.svs out.zarr
raw2ometiff out.zarr input.ome.tif --compression=jpeg
```

**QuPath** (GUI, nice for one-off slides):
File → Export → OME-TIFF.

## Using the reference manifest

`tissue_mask.json` is a reference manifest — it does **not** ship with
its own ONNX file because there is no public-domain pathology model that
we'd reuse without verification. To exercise the pipeline end-to-end:

1. Train or export any 3-channel input → 1-channel output ONNX patch
   model (HoVer-Net, CLAM, simple U-Net, etc.).
2. Adjust the `name`, `mpp`, `patch`, `stride`, and `output` fields in
   `tissue_mask.json` to match your model.
3. Load the slide + ONNX + manifest in the Pathology mode and click
   "Run on full slide".

The `inference` panel in the app shows progress patch-by-patch and the
result is overlaid on the slide using the colours declared in the
manifest's `output.colors` (or auto-assigned from the default palette).
