#!/usr/bin/env python3
"""Build and enrich Paetzold Lab publication data.

This script is intentionally offline-first for the website. It generates the
static JSON consumed by the frontend instead of calling Scholar, PDFs, or an
LLM from the browser.

Typical usage:
  python3 scripts/research_pipeline.py --enrich --download-pdfs --limit 10
  OPENAI_API_KEY=... python3 scripts/research_pipeline.py --enrich --llm --limit 10
  python3 scripts/research_pipeline.py --collect-scholar --enrich --write

Google Scholar scraping is fragile and may be rate-limited. Prefer dry-runs and
small limits before writing the production JSON.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
from io import BytesIO
import json
import math
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover - optional dependency
    fitz = None

try:
    from PIL import Image, ImageDraw, ImageFont, ImageStat
except ImportError:  # pragma: no cover - optional dependency
    Image = None
    ImageDraw = None
    ImageFont = None
    ImageStat = None


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "data" / "lab_members.json"
DEFAULT_INPUT = ROOT / "data" / "publications.json"
DEFAULT_OUTPUT = ROOT / "data" / "publications.json"
DEFAULT_PREVIEW = ROOT / "data" / "publications.preview.json"
PDF_CACHE_DIR = ROOT / "data" / "cache" / "pdfs"
AUTO_THUMB_DIR = ROOT / "images" / "publications" / "thumbnails" / "auto"
DEFAULT_THUMBNAIL = "images/publications/default.png"

SCHOLAR_BASE_URL = "https://scholar.google.com/citations"
REQUEST_DELAY_SECONDS = 1.5
REQUEST_TIMEOUT_SECONDS = 25
MAX_PDF_BYTES = 60 * 1024 * 1024
MAX_IMAGE_BYTES = 18 * 1024 * 1024
PDF_IMAGE_MIN_SCORE = 100
REMOTE_IMAGE_MIN_SCORE = 80

AUTO_THUMBNAIL_SOURCES = {"pdf", "page-image", "generated-card"}

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    )
}

CATEGORY_KEYWORDS: Dict[str, List[str]] = {
    "mri": ["mri", "magnetic resonance", "mr image", "mr imaging", "fmri"],
    "ct": [" ct ", "computed tomography", "cta", "cone-beam"],
    "ultrasound": ["ultrasound", "sonography", "echocardiography"],
    "x-ray": ["x-ray", "xray", "radiograph", "radiography"],
    "pet": [" pet ", "positron emission"],
    "histology": ["histology", "histopathology", "pathology slide"],
    "microscopy": ["microscopy", "microscope", "retinal", "fundus", "oct", "vasculature"],
    "spectroscopy": ["spectroscopy", "raman", "mid-ir", "mid ir", "ftir", "ft-ir", "qcl", "quantum cascade", "plasmonic", "lab-on-a-chip"],
    "gnn": ["graph neural", "gnn", "graph learning", "image-to-graph", "relationformer"],
    "generative": ["generative", "gan", "diffusion", "synthesis", "synthetic", "flow"],
    "vlm": ["vision language", "vision-language", "vlm", "multimodal", "language model"],
    "topology": ["topolog", "betti", "cldice", "skeleton", "persistence", "homology"],
    "segmentation": ["segment", "segmentation", "mask"],
    "reconstruction": ["reconstruction", "super-resolution", "super resolution"],
    "detection": ["detect", "detection", "localization"],
    "registration": ["registration", "register", "alignment"],
    "classification": ["classification", "classify", "staging", "prediction"],
}

CATEGORY_PATTERNS: Dict[str, List[str]] = {
    "mri": [
        r"\bmri\b",
        r"\bmr imaging\b",
        r"\bmagnetic resonance\b",
        r"\bfmri\b",
        r"\bdiffusion mri\b",
    ],
    "ct": [
        r"\bct\b",
        r"\bcta\b",
        r"\bcomputed tomography\b",
        r"\bcoronary ct\b",
        r"\bcone[- ]beam\b",
    ],
    "ultrasound": [r"\bultrasound\b", r"\bsonography\b", r"\bechocardiograph"],
    "x-ray": [r"\bx[- ]?ray\b", r"\bradiograph", r"\bradiography\b"],
    "pet": [r"\bpet\b", r"\bpositron emission\b"],
    "histology": [r"\bhistolog", r"\bhistopatholog", r"\bwhole slide\b", r"\bpathology slide\b"],
    "microscopy": [
        r"\bmicroscop",
        r"\blight[- ]sheet\b",
        r"\bretinal\b",
        r"\bfundus\b",
        r"\boct\b",
        r"\bocta\b",
        r"\bvasculature\b",
    ],
    "spectroscopy": [
        r"\bspectroscop",
        r"\braman\b",
        r"\bmid[- ]?ir\b",
        r"\bftir\b",
        r"\bft[- ]ir\b",
        r"\bqcl\b",
        r"\bquantum cascade\b",
        r"\bplasmonic",
        r"\blab[- ]on[- ]a[- ]chip\b",
        r"\binfrared\b",
    ],
    "gnn": [
        r"\bgraph neural\b",
        r"\bgnn\b",
        r"\bgraph learning\b",
        r"\bimage[- ]to[- ]graph\b",
        r"\brelationformer\b",
        r"\bgraph[- ]based\b",
    ],
    "generative": [
        r"\bgenerative\b",
        r"\bgan\b",
        r"\bdiffusion\b",
        r"\bsynthesis\b",
        r"\bsynthetic\b",
        r"\binpainting\b",
        r"\bflow model\b",
    ],
    "vlm": [
        r"\bvision[- ]language\b",
        r"\bvlm\b",
        r"\blanguage model\b",
        r"\bllm\b",
    ],
    "topology": [
        r"\btopolog",
        r"\bbetti\b",
        r"\bcldice\b",
        r"\bskeleton",
        r"\bpersistence\b",
        r"\bhomology\b",
        r"\beuler characteristic\b",
    ],
    "segmentation": [r"\bsegment", r"\bmask\b", r"\bparcellation\b"],
    "reconstruction": [r"\breconstruction\b", r"\bsuper[- ]resolution\b", r"\bdeblurring\b"],
    "detection": [r"\bdetect", r"\bdetection\b", r"\blocalization\b", r"\blocalisation\b"],
    "registration": [r"\bregistration\b", r"\bregister\b", r"\balignment\b", r"\bdeformable\b"],
    "classification": [
        r"\bclassification\b",
        r"\bclassify\b",
        r"\bstaging\b",
        r"\bprediction\b",
        r"\brisk categorization\b",
    ],
}

CATEGORY_THEME_COLORS: Dict[str, Tuple[str, str]] = {
    "mri": ("#111111", "#f2f2f2"),
    "ct": ("#111111", "#f2f2f2"),
    "ultrasound": ("#111111", "#f2f2f2"),
    "x-ray": ("#111111", "#f2f2f2"),
    "pet": ("#111111", "#f2f2f2"),
    "histology": ("#111111", "#f2f2f2"),
    "microscopy": ("#111111", "#f2f2f2"),
    "spectroscopy": ("#111111", "#f2f2f2"),
    "gnn": ("#111111", "#f2f2f2"),
    "generative": ("#111111", "#f2f2f2"),
    "vlm": ("#111111", "#f2f2f2"),
    "topology": ("#111111", "#f2f2f2"),
    "segmentation": ("#111111", "#f2f2f2"),
    "reconstruction": ("#111111", "#f2f2f2"),
    "detection": ("#111111", "#f2f2f2"),
    "registration": ("#111111", "#f2f2f2"),
    "classification": ("#111111", "#f2f2f2"),
    "uncertainty": ("#111111", "#f2f2f2"),
    "other": ("#111111", "#f2f2f2"),
}

MANUAL_EXCLUDED_PUBLICATION_IDS = {
    "auto_000625d71a",  # Superseded by the revised TG-OT title for arXiv:2412.17100.
    "pub017",  # Duplicate VesselGraph record; keep auto_e213107bcf with newer citations.
    "pub102",  # Conference abstract duplicated by the final 2024 Eye article (pub045).
    "auto_397902f83f",  # Old scrape of the retitled VERITAS arXiv:2604.12144; keep auto_74ca8cdcb0.
    "auto_05d4dfd6d8",  # Scholar glitch: same Velzen et al. record as auto_d6ae06e2a1 with a stray suffix.
    "auto_d2a5e42d61",  # IOVS conference abstract duplicated by the final 2024 Eye article (pub045).
    "auto_b0816faad7",  # "CH4 & CO2" spacing variant of the AGU abstract kept as auto_f609163725.
}

MANUAL_METADATA_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "auto_4c6619da6f": {
        "year": 2026,
        "venue": "Transactions on Machine Learning Research (TMLR)",
        "url": "https://openreview.net/forum?id=zw5EuUnBny",
        "pdf_link": "https://openreview.net/pdf?id=zw5EuUnBny",
        "summary": (
            "Models joint aleatoric and epistemic uncertainty with a scalable low-rank covariance "
            "approximation for high-dimensional vision outputs."
        ),
        "llm_tags": [
            "uncertainty quantification",
            "aleatoric uncertainty",
            "epistemic uncertainty",
            "output correlations",
            "low-rank covariance",
        ],
        "source_members": ["Johannes C. Paetzold", "Laurin Lux"],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from the accepted TMLR record on OpenReview",
        },
    },
    "auto_d0e46b0862": {
        "year": 2024,
        "venue": "arXiv",
        "url": "https://arxiv.org/abs/2412.17100",
        "pdf_link": "https://arxiv.org/pdf/2412.17100",
        "summary": (
            "Registers coronary CT angiography with intravascular ultrasound using topology-aware "
            "feature detection and optimal transport, without requiring prior segmentation."
        ),
        "llm_tags": [
            "CCTA-IVUS registration",
            "optimal transport",
            "topology-guided learning",
            "multimodal image fusion",
            "coronary imaging",
        ],
        "source_members": ["Johannes C. Paetzold", "Roel van Herten"],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from arXiv v2 metadata dated June 2026",
        },
    },
    "auto_ebdd832b58": {
        "url": "https://arxiv.org/abs/2605.06903",
        "pdf_link": "https://arxiv.org/pdf/2605.06903",
        "demo_url": "https://anon-review-meld-2026-meld.static.hf.space/index.html",
        "thumbnail": "images/publications/hero/auto_ebdd832b58-primary.jpg",
        "thumbnail_source": "manual-crop",
        "llm_tags": [
            "AI-generated text detection",
            "multi-task learning",
            "adversarial robustness",
            "low-FPR detection",
            "EMA distillation",
        ],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Promoted lab paper; arXiv metadata",
        },
    },
    "auto_482c89c131": {
        "venue": "MICCAI 2026 (early accepted), arXiv preprint",
        "url": "https://arxiv.org/abs/2605.26026",
        "pdf_link": "https://arxiv.org/pdf/2605.26026",
        "thumbnail": "images/publications/hero/auto_482c89c131-primary.jpg",
        "thumbnail_source": "manual-crop",
        "llm_tags": [
            "3D foundation model",
            "light-sheet microscopy",
            "few-shot segmentation",
            "classification",
            "deblurring",
        ],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from arXiv metadata and MICCAI 2026 acceptance comment",
        },
    },
    "pub036": {
        "thumbnail": "images/publications/manual_added/collateral_flow_stroke_figure1.jpg",
        "thumbnail_source": "manual-crop",
    },
    "pub038": {
        "thumbnail": "images/publications/manual_added/quality_estimation_segmentation_ensembles_figure1.jpg",
        "thumbnail_source": "manual-crop",
    },
    "pub030": {
        "pdf_link": "https://arxiv.org/pdf/2208.10992",
        "thumbnail": "images/publications/manual_added/structural_feature_autoencoder_pipeline.jpg",
        "thumbnail_source": "manual-pdf-crop",
    },
    "pub039": {
        "pdf_link": "https://arxiv.org/pdf/2112.13054",
        "thumbnail": "images/publications/manual_added/brats_2021_unet_architecture.jpg",
        "thumbnail_source": "manual-pdf-crop",
    },
    "pub104": {
        "thumbnail": "images/publications/manual_added/whole_brain_vasculature_dissertation_card.jpg",
        "thumbnail_source": "manual-card",
    },
    "auto_82bffbbf12": {
        "thumbnail": "images/publications/manual_added/segmentation_metrics_expert_rating.jpg",
        "thumbnail_source": "manual-pdf-crop",
    },
    "auto_02f80253af": {
        "thumbnail": "images/publications/manual_added/nanocarrier_whole_body_analysis.jpg",
        "thumbnail_source": "manual-figure-crop",
    },
    "auto_170175955e": {
        "thumbnail": "images/publications/manual_added/fets_2024_federated_learning_process.jpg",
        "thumbnail_source": "manual-pdf-crop",
    },
    "auto_b7647988ae": {
        "thumbnail": "images/publications/manual_added/coronary_plaque_fancnn_method.jpg",
        "thumbnail_source": "manual-pdf-crop",
    },
    "auto_74ca8cdcb0": {
        # The paper was retitled on arXiv; keep this id so hero assets stay attached.
        "title": "VERITAS: A Multi-Agent Co-Scientist for Verifiable Image-Derived Hypothesis Testing",
        "url": "https://arxiv.org/abs/2604.12144",
        "pdf_link": "https://arxiv.org/pdf/2604.12144",
        "thumbnail": "images/publications/hero/auto_74ca8cdcb0-primary.jpg",
        "thumbnail_source": "manual-crop",
        "llm_tags": [
            "verifiable reasoning",
            "agentic systems",
            "hypothesis testing",
            "image-derived evidence",
            "uncertainty",
        ],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Promoted lab paper; title/metadata from the retitled arXiv:2604.12144 record",
        },
    },
    "auto_09034b913d": {
        "venue": "Medical Imaging with Deep Learning (MIDL)",
        "url": "https://proceedings.mlr.press/v315/lux26a.html",
        "pdf_link": "https://raw.githubusercontent.com/mlresearch/v315/main/assets/lux26a/lux26a.pdf",
        "abstract": (
            "Region-based loss functions such as Dice are widely used for highly class-imbalanced segmentation, "
            "but can produce over-confident and miscalibrated predictions. This work introduces a gradient vector "
            "field surgery that scales the loss gradient with probabilistic error to improve segmentation calibration "
            "while preserving accuracy across 2D and 3D medical segmentation tasks."
        ),
        "summary": (
            "Laurin Lux and collaborators improve the calibration of medical segmentation models by modifying the "
            "gradient dynamics of region-based losses. The method targets over-confidence in Dice-style training "
            "while maintaining segmentation accuracy."
        ),
        "llm_tags": [
            "segmentation calibration",
            "gradient surgery",
            "Dice loss",
            "tumor segmentation",
            "trustworthy AI",
        ],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from PMLR 315 and OpenReview MIDL 2026 metadata",
        },
    },
    "auto_6a0d2c02b8": {
        "venue": "Medical Imaging with Deep Learning (MIDL)",
        "url": "https://proceedings.mlr.press/v315/varma26a.html",
        "pdf_link": "https://raw.githubusercontent.com/mlresearch/v315/main/assets/varma26a/varma26a.pdf",
        "abstract": (
            "SegMaST is a Mamba-based spatio-temporal framework for longitudinal medical image segmentation. "
            "It jointly segments baseline and follow-up scans, localizes new or progressive pathologies, and "
            "uses imbalance-aware learning for realistic disease progression datasets."
        ),
        "summary": (
            "SegMaST models longitudinal MRI scans with a spatio-temporal Mamba architecture, improving follow-up "
            "segmentation and lesion detection for multiple sclerosis and glioma cohorts."
        ),
        "llm_tags": [
            "longitudinal segmentation",
            "Mamba",
            "neuroimaging",
            "disease progression",
            "lesion detection",
        ],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from PMLR 315 and OpenReview MIDL 2026 metadata",
        },
    },
    "auto_82686f45e6": {
        "venue": "Medical Imaging with Deep Learning (MIDL)",
        "url": "https://proceedings.mlr.press/v315/herten26a.html",
        "pdf_link": "https://raw.githubusercontent.com/mlresearch/v315/main/assets/herten26a/herten26a.pdf",
        "thumbnail": "images/publications/hero/auto_82686f45e6-method.jpg",
        "thumbnail_source": "manual-pdf-crop",
        "abstract": (
            "GeoReg directly registers biplanar digital subtraction angiography to pre-procedural CTA for acute ischemic stroke. "
            "The method avoids vessel-specific segmentation by aligning maximum intensity projections from DSA with differentiable "
            "CTA renderings and uses geodesic consistency constraints for robust biplanar optimization."
        ),
        "summary": (
            "GeoReg provides segmentation-free DSA-to-CTA registration for stroke interventions by optimizing biplanar views with "
            "soft geodesic consistency constraints."
        ),
        "llm_tags": [
            "image registration",
            "DSA-to-CTA",
            "stroke imaging",
            "geodesic consistency",
            "segmentation-free optimization",
        ],
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from PMLR 315 and OpenReview MIDL 2026 metadata",
        },
    },
    "auto_6295fd2b61": {
        "thumbnail": "images/publications/hero/auto_6295fd2b61-primary.jpg",
        "thumbnail_source": "manual-crop",
        "llm_tags": [
            "medical VLM",
            "synthetic vasculature",
            "OCTA reasoning",
            "pathology simulation",
            "explainable diagnosis",
        ],
    },
    "pub119": {
        "llm_tags": [
            "medical VLM",
            "graph knowledge",
            "explainable AI",
            "retinal imaging",
            "clinical reasoning",
        ],
    },
    "pub002": {
        "llm_tags": [
            "topology-preserving loss",
            "tubular segmentation",
            "centerline Dice",
            "vascular structures",
            "connectivity",
        ],
    },
    "auto_d99c05eb0a": {
        "llm_tags": [
            "vertebrae segmentation",
            "benchmark",
            "multi-detector CT",
            "spine labeling",
            "medical image analysis",
        ],
    },
    "pub001": {
        "llm_tags": [
            "whole-brain vasculature",
            "machine learning",
            "tissue clearing",
            "3D microscopy",
            "vascular analysis",
        ],
    },
    "pub069": {
        "venue": "PMLR 194: Geometric Deep Learning in Medical Image Analysis",
        "pdf_link": "https://proceedings.mlr.press/v194/prabhakar22a/prabhakar22a.pdf",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from PMLR citation metadata",
        },
    },
    "pub075": {
        "year": 2022,
        "venue": "MIDL 2022 Conference",
        "pdf_link": "https://openreview.net/pdf?id=vAxp4zGTIVw",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from OpenReview citation metadata",
        },
    },
    "pub103": {
        "title": "Automated Analysis of Diabetic Retinopathy Using Vessel Segmentation Maps as Inductive Bias",
        "venue": "MICCAI 2022 Challenges MIDOG/DRAC, Lecture Notes in Computer Science",
        "doi": "10.1007/978-3-031-33658-4_2",
        "url": "https://doi.org/10.1007/978-3-031-33658-4_2",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from Springer/Google Books metadata",
        },
    },
    "pub104": {
        "venue": "Doctoral dissertation, Technical University of Munich",
        "pdf_link": "https://mediatum.ub.tum.de/doc/1659236/document.pdf",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from mediaTUM citation metadata",
        },
    },
    "pub107": {
        "venue": "Google Scholar record",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Title/year verified from Google Scholar profile record; venue not exposed",
        },
    },
    "pub109": {
        "venue": "OCO-2 Science Team Meeting",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from mediaTUM citation metadata",
        },
    },
    "pub113": {
        "title": "Exploring Graphs as Data Representation for Disease Classification in Ophthalmology",
        "year": 2025,
        "venue": "GRAIL@MICCAI 2024, Lecture Notes in Computer Science 15182",
        "doi": "10.1007/978-3-031-83243-7_5",
        "url": "https://doi.org/10.1007/978-3-031-83243-7_5",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from Springer/TUM publication metadata",
        },
    },
    "pub114": {
        "year": 2024,
        "venue": "OpenReview, ICLR 2025 Conference Withdrawn Submission",
        "pdf_link": "https://openreview.net/pdf?id=Ilteh48w7m",
        "metadata_verified": {
            "source": "manual",
            "status": "matched",
            "note": "Verified from OpenReview citation metadata",
        },
    },
}

PROMOTION_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "auto_482c89c131": {
        "featuredOrder": 0,
        "promotion_rank": 0,
        "featured_reason": "Promoted: Adina Scheinfeld MICCAI",
    },
    "auto_09034b913d": {
        "featuredOrder": 1,
        "promotion_rank": 1,
        "featured_reason": "Promoted: Laurin Lux and Alexander Berger MIDL",
    },
    "auto_74ca8cdcb0": {
        "featuredOrder": 2,
        "promotion_rank": 2,
        "featured_reason": "Promoted: Lucas Stoffl VERITAS",
    },
    "auto_82686f45e6": {
        "featuredOrder": 3,
        "promotion_rank": 3,
        "featured_reason": "Promoted: Roel van Herten MIDL",
    },
    "auto_ebdd832b58": {
        "featuredOrder": 4,
        "promotion_rank": 4,
        "featured_reason": "Promoted after other member papers: Chenjun Li MELD",
    },
    "pub002": {
        "featuredOrder": 5,
        "promotion_rank": 5,
        "featured_reason": "Promoted: clDice",
    },
    "auto_6295fd2b61": {
        "featuredOrder": 6,
        "promotion_rank": 6,
        "featured_reason": "Promoted later: Chenjun Li MIDL",
    },
    "pub119": {
        "featuredOrder": 7,
        "promotion_rank": 7,
        "featured_reason": "Promoted: medical VLM",
    },
}

DEPRIORITIZED_FEATURED_IDS = {
    "auto_9732c60678",  # LiTS: important benchmark, but not a primary Paetzold Lab lead paper.
}

MANUAL_CATEGORY_OVERRIDES: Dict[str, List[str]] = {
    "auto_4c6619da6f": ["uncertainty"],
    "auto_d0e46b0862": ["ct", "registration", "topology"],
    "auto_482c89c131": ["microscopy", "segmentation", "classification", "reconstruction"],
    # Laurin Lux / Alexander Berger lab-facing papers.
    "auto_09034b913d": ["segmentation"],
    "auto_6a0d2c02b8": ["segmentation", "mri", "detection"],
    "pub053": ["microscopy", "gnn", "classification"],
    "pub055": ["topology", "segmentation"],
    "pub088": ["microscopy", "gnn", "classification"],
    "pub099": ["gnn", "microscopy", "classification"],
    "pub114": ["uncertainty"],
    "auto_46ecb6ea36": ["mri"],
    "auto_6bda5dfce7": ["mri"],
    "auto_3a39f23842": ["mri"],
    # Laurin's spectroscopy / optical sensing work should not be shown as medical ultrasound or AI detection.
    "auto_24fa101f13": ["spectroscopy"],
    "auto_1fc2efc9b1": ["spectroscopy"],
    "auto_32c39cebac": ["spectroscopy"],
    "auto_6f1d2e54fe": ["spectroscopy"],
    "auto_2da7bc5e8d": ["spectroscopy"],
    "auto_3dfe21e2ac": ["spectroscopy"],
    "auto_3a3624294d": ["spectroscopy"],
    "auto_37066ed9be": ["spectroscopy"],
    "auto_73c0812334": ["spectroscopy"],
    "auto_81fde4b724": ["spectroscopy"],
    "auto_da666dc760": ["spectroscopy"],
    "auto_714dd26ca5": ["spectroscopy"],
}

MANUAL_REPRESENTATIVE_INCLUDES: Dict[str, List[str]] = {
    "Laurin Lux": ["auto_4c6619da6f", "auto_09034b913d", "pub055", "pub088"],
}

MANUAL_REPRESENTATIVE_EXCLUDES: Dict[str, List[str]] = {
    "Laurin Lux": ["auto_815584096b", "auto_24fa101f13", "auto_1fc2efc9b1"],
}


@dataclass
class LabMember:
    name: str
    role: str = ""
    scholar_id: str = ""
    aliases: Tuple[str, ...] = ()
    min_year: int = 0
    exclude_title_patterns: Tuple[str, ...] = ()

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> "LabMember":
        def parse_int(value: Any) -> int:
            try:
                return int(value)
            except (TypeError, ValueError):
                return 0

        return cls(
            name=str(data.get("name", "")).strip(),
            role=str(data.get("role", "")).strip(),
            scholar_id=str(data.get("scholar_id", "")).strip(),
            aliases=tuple(str(a).strip() for a in data.get("aliases", []) if str(a).strip()),
            min_year=parse_int(data.get("min_year")),
            exclude_title_patterns=tuple(
                str(p).strip().lower()
                for p in data.get("exclude_title_patterns", [])
                if str(p).strip()
            ),
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json_atomic(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    tmp.replace(path)


def normalize_title(title: str) -> str:
    text = re.sub(r"\s+", " ", title.lower()).strip()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def stable_id(title: str) -> str:
    digest = hashlib.sha1(normalize_title(title).encode("utf-8")).hexdigest()[:10]
    return f"auto_{digest}"


def slugify(value: str, max_len: int = 90) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return (slug or "publication")[:max_len]


def trim(value: Any) -> str:
    return str(value or "").strip()


def compact_venue(value: Any) -> str:
    text = re.sub(r"\s+", " ", trim(value).replace("\u00a0", " "))
    if not text:
        return ""

    compact_names: List[Tuple[str, str]] = [
        (r"medical imaging with deep learning|MIDL", "Medical Imaging with Deep Learning (MIDL)"),
        (r"medical image computing and computer-assisted|MICCAI", "MICCAI"),
        (r"machine learning in medical imaging|MLMI", "MLMI"),
        (r"information processing in medical imaging|IPMI", "IPMI"),
        (r"computer vision and pattern recognition|CVPR", "CVPR"),
        (r"international conference on computer vision|ICCV", "ICCV"),
        (r"winter conference on applications of computer vision|WACV", "WACV"),
        (r"learning representations|ICLR", "ICLR"),
        (r"neural information processing systems|NeurIPS", "NeurIPS"),
        (r"international symposium on biomedical image processing|ISBI", "ISBI"),
    ]
    for pattern, label in compact_names:
        if re.search(pattern, text, flags=re.IGNORECASE):
            return label
    return text


def as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def load_members(config: Dict[str, Any]) -> List[LabMember]:
    return [LabMember.from_json(m) for m in config.get("members", []) if m.get("name")]


def fold_ascii(value: str) -> str:
    return (
        unicodedata.normalize("NFKD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
    )


def normalize_person(value: str) -> str:
    text = fold_ascii(value).lower()
    text = re.sub(r"[\.\*¹²³]", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def member_alias_map(members: List[LabMember]) -> Dict[str, str]:
    aliases: Dict[str, str] = {}
    for member in members:
        names = [member.name, *member.aliases]
        for name in names:
            normalized = normalize_person(name)
            if normalized:
                aliases[normalized] = member.name
    return aliases


def member_last_name(member: LabMember) -> str:
    tokens = normalize_person(member.name).split()
    if not tokens:
        return ""
    if len(tokens) >= 3 and tokens[-2] in {"van", "von", "de", "der", "den"}:
        return " ".join(tokens[-2:])
    return tokens[-1]


def author_mentions_member(authors: str, member: LabMember) -> bool:
    haystack = normalize_person(authors)
    if not haystack:
        return False

    for name in [member.name, *member.aliases]:
        alias = normalize_person(name)
        if alias and re.search(rf"\b{re.escape(alias)}\b", haystack):
            return True

    tokens = normalize_person(member.name).split()
    if not tokens:
        return False
    first = tokens[0]
    first_initial = first[0]
    last = member_last_name(member)
    if not last:
        return False

    last_re = re.escape(last)
    full_first = rf"\b{re.escape(first)}(?:\s+[a-z]+){{0,3}}\s+{last_re}\b"
    initials = rf"\b{re.escape(first_initial)}(?:\s+[a-z]){{0,3}}\s+{last_re}\b"
    compact_initials = rf"\b{re.escape(first_initial)}[a-z]{{0,3}}\s+{last_re}\b"
    return any(re.search(pattern, haystack) for pattern in [full_first, initials, compact_initials])


def canonical_source_members(pub: Dict[str, Any], members: List[LabMember]) -> List[str]:
    aliases = member_alias_map(members)
    source_members = set()
    for raw in pub.get("source_members") or []:
        normalized = normalize_person(str(raw))
        source_members.add(aliases.get(normalized, str(raw).strip()))

    authors = trim(pub.get("authors"))
    for member in members:
        if author_mentions_member(authors, member):
            source_members.add(member.name)

    title_lower = trim(pub.get("title")).lower()
    year = as_int(pub.get("year"))
    filtered = []
    for member in members:
        if member.name not in source_members:
            continue
        if member.min_year and year and year < member.min_year:
            continue
        if any(pattern in title_lower for pattern in member.exclude_title_patterns):
            continue
        filtered.append(member.name)
    return filtered


def scholar_profile_url(scholar_id: str, start: int = 0, page_size: int = 100) -> str:
    return (
        f"{SCHOLAR_BASE_URL}?user={scholar_id}&hl=en"
        f"&cstart={start}&pagesize={page_size}"
    )


def fetch_html(url: str, *, timeout: int = REQUEST_TIMEOUT_SECONDS) -> Optional[str]:
    try:
        response = requests.get(url, headers=REQUEST_HEADERS, timeout=timeout)
        response.raise_for_status()
        return response.text
    except requests.RequestException as exc:
        print(f"warn: failed to fetch {url}: {exc}", file=sys.stderr)
        return None


def parse_scholar_profile(html: str, member: LabMember) -> List[Dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select(".gsc_a_tr")
    publications: List[Dict[str, Any]] = []
    for row in rows:
        title_anchor = row.select_one("a.gsc_a_at") or row.select_one(".gsc_a_t a")
        if not title_anchor:
            continue

        title = title_anchor.get_text(" ", strip=True)
        if not title:
            continue

        gray_parts = row.select(".gsc_a_t .gs_gray")
        authors = gray_parts[0].get_text(" ", strip=True) if len(gray_parts) > 0 else ""
        venue_raw = gray_parts[1].get_text(" ", strip=True) if len(gray_parts) > 1 else ""
        year_text = row.select_one(".gsc_a_y span")
        year = as_int(year_text.get_text(strip=True) if year_text else "")
        if not year:
            match = re.search(r"(19|20)\d{2}", venue_raw)
            year = as_int(match.group(0)) if match else 0

        if member.min_year and year and year < member.min_year:
            continue
        title_lower = title.lower()
        if any(pattern in title_lower for pattern in member.exclude_title_patterns):
            continue

        venue = re.sub(r"(19|20)\d{2}", "", venue_raw).strip(" ,;")
        citation_anchor = row.select_one(".gsc_a_c a")
        citations = as_int(citation_anchor.get_text(strip=True) if citation_anchor else 0)
        href = title_anchor.get("href", "")
        scholar_link = href if href.startswith("/") else ""
        url = urljoin("https://scholar.google.com", href) if href else ""

        publications.append(
            {
                "id": stable_id(title),
                "title": title,
                "authors": authors,
                "year": year or "",
                "venue": venue,
                "venue_tag": venue.upper() if venue else None,
                "doi": None,
                "abstract": "",
                "summary": "",
                "url": url,
                "scholar_link": scholar_link,
                "citations": citations,
                "pdf_link": "",
                "categories": keyword_categories(f"{title} {venue}"),
                "primary_category": None,
                "thumbnail": DEFAULT_THUMBNAIL,
                "featured": False,
                "featuredOrder": 999,
                "source_members": [member.name],
                "source": "google_scholar",
            }
        )
    return publications


def collect_from_scholar(
    members: Iterable[LabMember],
    *,
    max_pages: int,
    page_size: int,
    request_delay: float,
    member_filter: Optional[str] = None,
) -> List[Dict[str, Any]]:
    collected: List[Dict[str, Any]] = []
    selected = list(members)
    if member_filter:
        needle = member_filter.lower()
        selected = [
            m
            for m in selected
            if needle in m.name.lower() or needle == m.scholar_id.lower()
        ]

    for member in selected:
        if not member.scholar_id:
            print(f"skip: no Scholar ID configured for {member.name}")
            continue

        print(f"collect: {member.name} ({member.scholar_id})")
        for page_index in range(max_pages):
            url = scholar_profile_url(member.scholar_id, page_index * page_size, page_size)
            html = fetch_html(url)
            if not html:
                break
            page_pubs = parse_scholar_profile(html, member)
            if not page_pubs:
                break
            collected.extend(page_pubs)
            print(f"  page {page_index + 1}: {len(page_pubs)} rows")
            if len(page_pubs) < page_size:
                break
            time.sleep(request_delay)
    return collected


def merge_publications(
    existing: List[Dict[str, Any]],
    incoming: List[Dict[str, Any]],
    *,
    overwrite: bool = False,
) -> List[Dict[str, Any]]:
    by_title: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    for pub in existing:
        key = normalize_title(trim(pub.get("title")))
        if not key:
            continue
        if key in by_title:
            current = by_title[key]
            current["citations"] = max(as_int(current.get("citations")), as_int(pub.get("citations")))
            for field in ["year", "venue", "venue_tag", "url", "scholar_link", "pdf_link", "thumbnail", "abstract"]:
                if not trim(current.get(field)) and trim(pub.get(field)):
                    current[field] = pub[field]
            continue
        by_title[key] = pub
        order.append(key)

    for pub in incoming:
        key = normalize_title(trim(pub.get("title")))
        if not key:
            continue
        if key not in by_title:
            by_title[key] = pub
            order.append(key)
            continue

        current = by_title[key]
        if overwrite:
            merged = {**current, **{k: v for k, v in pub.items() if v not in ("", None, [])}}
        else:
            merged = {**pub, **current}

        merged["citations"] = max(as_int(current.get("citations")), as_int(pub.get("citations")))
        for field in ["year", "venue", "venue_tag", "url", "scholar_link", "pdf_link"]:
            if not trim(current.get(field)) and trim(pub.get(field)):
                merged[field] = pub[field]
        if (not current.get("categories")) and pub.get("categories"):
            merged["categories"] = pub["categories"]
        if (not trim(current.get("primary_category"))) and trim(pub.get("primary_category")):
            merged["primary_category"] = pub["primary_category"]

        source_members = set(current.get("source_members") or [])
        source_members.update(pub.get("source_members") or [])
        if source_members:
            merged["source_members"] = sorted(source_members)
        by_title[key] = merged

    return [by_title[key] for key in order]


def keyword_categories(text: str) -> List[str]:
    haystack = re.sub(r"\s+", " ", f" {text.lower()} ")
    categories: List[str] = []
    for category, patterns in CATEGORY_PATTERNS.items():
        if any(re.search(pattern, haystack, flags=re.IGNORECASE) for pattern in patterns):
            categories.append(category)
    return list(dict.fromkeys(categories))


def first_sentences(text: str, max_chars: int = 500) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if not clean:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", clean)
    summary = " ".join(parts[:3]).strip()
    return summary[:max_chars].rstrip()


def extract_abstract_section(text: str, max_chars: int = 1400) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if not clean:
        return ""

    lower = clean.lower()
    start = lower.find("abstract")
    if start < 0:
        return ""

    start += len("abstract")
    while start < len(clean) and clean[start] in ".:- \t":
        start += 1

    stop_candidates = []
    for marker in [
        " introduction",
        " 1 introduction",
        " keywords",
        " index terms",
        " methods",
    ]:
        idx = lower.find(marker, start)
        if idx > start:
            stop_candidates.append(idx)
    stop = min(stop_candidates) if stop_candidates else min(len(clean), start + max_chars)
    abstract = clean[start:stop].strip()
    return abstract[:max_chars].rstrip()


def title_similarity(left: str, right: str) -> float:
    a = normalize_title(left)
    b = normalize_title(right)
    if not a or not b:
        return 0.0
    seq = difflib.SequenceMatcher(None, a, b).ratio()
    a_tokens = set(a.split())
    b_tokens = set(b.split())
    if not a_tokens or not b_tokens:
        return seq
    overlap = len(a_tokens & b_tokens)
    jaccard = overlap / len(a_tokens | b_tokens)
    containment = overlap / min(len(a_tokens), len(b_tokens))
    return max(seq, (jaccard * 0.45) + (containment * 0.55))


def canonical_duplicate_key(title: str) -> str:
    key = normalize_title(title)
    key = re.sub(r"\bxco 2\b", "xco2", key)
    key = re.sub(r"\bco 2\b", "co2", key)
    key = re.sub(r"\barxiv org e print archive\b", "", key)
    key = re.sub(r"\barxiv 20\d{2}\b", "", key)
    key = re.sub(r"\bsupplementary material for\b", "", key)
    key = re.sub(r"\bsupplementary material\b", "", key)
    key = re.sub(r"\bproceedings of machine learning research\b", "", key)
    key = re.sub(r"\s+", " ", key).strip()

    if "are we using appropriate segmentation metrics" in key:
        return "are we using appropriate segmentation metrics identifying correlates of human expert perception"
    if "vertebrae labelling and segmentation benchmark" in key:
        return "verse vertebrae labelling and segmentation benchmark"
    if "anthropogenic co2 emissions assessment of nile delta" in key:
        return "anthropogenic co2 emissions assessment of nile delta"
    if "totalvibesegmentator full" in key or "total vibe segmentator full" in key:
        return "totalvibesegmentator full body mri segmentation"
    return key


def is_excludable_publication(pub: Dict[str, Any]) -> bool:
    if trim(pub.get("id")) in MANUAL_EXCLUDED_PUBLICATION_IDS:
        return True
    title_key = normalize_title(trim(pub.get("title")))
    if not title_key:
        return True
    if "supplementary material" in title_key:
        return True
    if title_key.startswith("msc thesis"):
        return True
    if title_key == "and segmentation of aneurysm":
        return True
    if re.match(r"^suprosanna shit .*are we using appropriate segmentation metrics", title_key):
        return True
    # Scholar sometimes repeats the whole title twice in one profile row.
    words = title_key.split()
    if len(words) >= 8 and len(words) % 2 == 0 and words[: len(words) // 2] == words[len(words) // 2:]:
        return True
    return False


def publication_score_for_merge(pub: Dict[str, Any]) -> Tuple[int, int, int, int, int, int]:
    title = normalize_title(trim(pub.get("title")))
    malformed = 1 if re.match(r"^[a-z]+ [a-z]+ .* et al", title) else 0
    has_verified = 1 if (pub.get("metadata_verified") or {}).get("source") else 0
    has_members = 1 if pub.get("source_members") else 0
    has_venue = 1 if trim(pub.get("venue")) else 0
    has_thumbnail = 1 if trim(pub.get("thumbnail")) not in ("", DEFAULT_THUMBNAIL, f"./{DEFAULT_THUMBNAIL}") else 0
    return (
        -malformed,
        has_verified,
        has_members,
        has_venue,
        has_thumbnail,
        as_int(pub.get("citations")),
    )


def merge_duplicate_group(group: List[Dict[str, Any]]) -> Dict[str, Any]:
    selected = max(group, key=publication_score_for_merge)
    merged = dict(selected)
    merged["citations"] = max(as_int(pub.get("citations")) for pub in group)

    source_members = set()
    categories = []
    representative_for = set()
    featured_orders = []
    for pub in group:
        source_members.update(pub.get("source_members") or [])
        representative_for.update(pub.get("representative_for") or [])
        categories.extend(pub.get("categories") or [])
        if pub.get("featuredOrder") is not None:
            featured_orders.append(as_int(pub.get("featuredOrder")))
        for field in ["year", "venue", "venue_tag", "doi", "url", "scholar_link", "pdf_link", "abstract", "summary", "thumbnail"]:
            if not trim(merged.get(field)) and trim(pub.get(field)):
                merged[field] = pub[field]

    if source_members:
        merged["source_members"] = sorted(source_members)
    if categories:
        merged["categories"] = list(dict.fromkeys(categories))
    if any(pub.get("featured") for pub in group):
        merged["featured"] = True
    if featured_orders:
        merged["featuredOrder"] = min(featured_orders)
    if any(pub.get("representative") for pub in group):
        merged["representative"] = True
    if representative_for:
        merged["representative_for"] = sorted(representative_for)
    if len(group) > 1:
        merged["merged_from"] = sorted(
            trim(pub.get("id")) or stable_id(trim(pub.get("title")))
            for pub in group
        )
    return merged


def publication_id(pub: Dict[str, Any]) -> str:
    return trim(pub.get("id")) or stable_id(trim(pub.get("title")))


def apply_promotion_overrides(publications: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for pub in publications:
        pub_id = publication_id(pub)
        if pub_id in DEPRIORITIZED_FEATURED_IDS:
            pub["featured"] = False
            pub["featuredOrder"] = 999
            pub.pop("promotion_rank", None)
            pub["priority_note"] = "Kept in publications, removed from homepage promotion."
            continue

        override = PROMOTION_OVERRIDES.get(pub_id)
        if not override:
            pub.pop("promotion_rank", None)
            pub.pop("featured_reason", None)
            continue

        pub.update(override)
        pub["featured"] = True
    return publications


# Scholar/arXiv metadata still hands back http:// links for hosts that are
# https-only in practice; upgrade the scheme only for hosts known to serve https.
HTTPS_UPGRADE_HOSTS = {
    "arxiv.org",
    "www.arxiv.org",
    "doi.org",
    "dx.doi.org",
    "openaccess.thecvf.com",
    "proceedings.mlr.press",
    "www.nature.com",
}


def upgrade_to_https(url: str) -> str:
    link = trim(url)
    if not link.lower().startswith("http://"):
        return link
    host = link[7:].split("/", 1)[0].split("?", 1)[0].lower()
    return "https://" + link[7:] if host in HTTPS_UPGRADE_HOSTS else link


def normalize_publication_records(
    publications: List[Dict[str, Any]],
    *,
    members: List[LabMember],
    allowed_categories: Dict[str, str],
    dedupe: bool = True,
) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    allowed = set(allowed_categories.keys())
    for pub in publications:
        item = dict(pub)
        override = MANUAL_METADATA_OVERRIDES.get(trim(item.get("id")))
        if override:
            item.update(override)
        if is_excludable_publication(item):
            continue
        title = trim(item.get("title"))
        if not trim(item.get("id")):
            item["id"] = stable_id(title)

        item["source_members"] = canonical_source_members(item, members)
        if not item["source_members"]:
            # Keep the record, but audit will flag it. Some older papers lack
            # complete author metadata in Scholar.
            item["source_members"] = []

        source_text = " ".join(
            part
            for part in [
                title,
                trim(item.get("venue")),
                trim(item.get("abstract")),
                trim(item.get("summary")),
                " ".join(item.get("llm_tags") or []),
                trim(item.get("modality")),
                trim(item.get("task")),
            ]
            if part
        )
        category_override = MANUAL_CATEGORY_OVERRIDES.get(publication_id(item))
        inferred_categories = [c for c in (category_override or keyword_categories(source_text)) if c in allowed][:4]
        if not inferred_categories and "other" in allowed:
            inferred_categories = ["other"]
        item["categories"] = inferred_categories
        primary = trim(item.get("primary_category"))
        item["primary_category"] = primary if primary in inferred_categories else (inferred_categories[0] if inferred_categories else None)

        venue = compact_venue(item.get("venue"))
        item["venue"] = venue
        item["venue_tag"] = venue.upper() if venue else None
        for link_field in ("url", "pdf_link", "demo_url"):
            if trim(item.get(link_field)):
                item[link_field] = upgrade_to_https(item[link_field])
        if not trim(item.get("thumbnail")):
            item["thumbnail"] = DEFAULT_THUMBNAIL
        normalized.append(item)

    if not dedupe:
        return apply_promotion_overrides(normalized)

    groups: Dict[str, List[Dict[str, Any]]] = {}
    order: List[str] = []
    for pub in normalized:
        key = canonical_duplicate_key(trim(pub.get("title")))
        if key not in groups:
            order.append(key)
            groups[key] = []
        groups[key].append(pub)
    return apply_promotion_overrides([merge_duplicate_group(groups[key]) for key in order])


def openalex_work_url(work_id: str) -> str:
    return work_id if work_id.startswith("http") else f"https://openalex.org/{work_id}"


def openalex_search_text(title: str) -> str:
    text = fold_ascii(title)
    text = re.sub(r"[?\"“”‘’`]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def openalex_best_match(title: str, *, request_delay: float = 0.0) -> Optional[Tuple[Dict[str, Any], float]]:
    if not title:
        return None
    query = openalex_search_text(title)
    if not query:
        return None
    try:
        response = requests.get(
            "https://api.openalex.org/works",
            params={"search": query, "per-page": 5},
            headers=REQUEST_HEADERS,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        results = response.json().get("results", [])
    except requests.RequestException as exc:
        print(f"warn: OpenAlex lookup failed for {title[:80]}: {exc}", file=sys.stderr)
        return None
    finally:
        if request_delay:
            time.sleep(request_delay)

    best: Optional[Tuple[Dict[str, Any], float]] = None
    for work in results:
        score = title_similarity(title, trim(work.get("title")))
        if best is None or score > best[1]:
            best = (work, score)
    if best and best[1] >= 0.88:
        return best
    return None


def openalex_venue(work: Dict[str, Any]) -> str:
    location = work.get("primary_location") or {}
    source = location.get("source") or {}
    return trim(source.get("display_name"))


def openalex_landing_url(work: Dict[str, Any]) -> str:
    location = work.get("primary_location") or {}
    return trim(location.get("landing_page_url")) or trim(work.get("doi"))


def normalize_doi(value: Any) -> str:
    doi = trim(value)
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi, flags=re.IGNORECASE)
    return doi


def verify_publications_with_openalex(
    publications: List[Dict[str, Any]],
    *,
    request_delay: float,
    limit: int = 0,
) -> List[Dict[str, Any]]:
    verified: List[Dict[str, Any]] = []
    checked = 0
    for pub in publications:
        item = dict(pub)
        if limit and checked >= limit:
            verified.append(item)
            continue
        checked += 1
        title = trim(item.get("title"))
        print(f"verify: {checked} {title[:90]}")
        match = openalex_best_match(title, request_delay=request_delay)
        if not match:
            if not (item.get("metadata_verified") or {}).get("source"):
                item["metadata_verified"] = {
                    "source": "",
                    "status": "unmatched",
                    "at": utc_now(),
                }
            verified.append(item)
            continue

        work, score = match
        venue = openalex_venue(work)
        year = as_int(work.get("publication_year"))
        doi = normalize_doi(work.get("doi"))
        landing_url = openalex_landing_url(work)
        open_access = work.get("open_access") or {}
        oa_url = trim(open_access.get("oa_url"))

        if doi and not trim(item.get("doi")):
            item["doi"] = doi
        if year and (not as_int(item.get("year")) or as_int(item.get("year")) < 1900):
            item["year"] = year
        if venue and not trim(item.get("venue")):
            item["venue"] = venue
            item["venue_tag"] = venue.upper()
        if landing_url and (not trim(item.get("url")) or "scholar.google.com" in trim(item.get("url"))):
            item["url"] = landing_url
        if oa_url.lower().endswith(".pdf") and not trim(item.get("pdf_link")):
            item["pdf_link"] = oa_url

        item["metadata_verified"] = {
            "source": "openalex",
            "status": "matched",
            "score": round(score, 3),
            "openalex_id": openalex_work_url(trim(work.get("id"))),
            "matched_title": trim(work.get("title")),
            "at": utc_now(),
        }
        verified.append(item)
    return verified


def thumbnail_exists(thumbnail: str) -> bool:
    path = trim(thumbnail)
    if not path:
        return False
    if path.startswith("http://") or path.startswith("https://"):
        return True
    if path.startswith("./"):
        path = path[2:]
    return (ROOT / path).exists()


def audit_publications(
    publications: List[Dict[str, Any]],
    *,
    members: List[LabMember],
    allowed_categories: Dict[str, str],
) -> Dict[str, Any]:
    member_names = {member.name for member in members}
    allowed = set(allowed_categories.keys())
    issues = []
    summary = {
        "total": len(publications),
        "missing_year": 0,
        "missing_venue": 0,
        "missing_categories": 0,
        "missing_source_members": 0,
        "broken_thumbnails": 0,
        "default_thumbnails": 0,
        "openalex_matched": 0,
        "openalex_unmatched": 0,
        "chenjun_policy_violations": 0,
    }

    for pub in publications:
        pub_issues = []
        title = trim(pub.get("title"))
        year = as_int(pub.get("year"))
        venue = trim(pub.get("venue"))
        categories = pub.get("categories") or []
        source_members = pub.get("source_members") or []
        thumbnail = trim(pub.get("thumbnail"))

        if not title:
            pub_issues.append("missing_title")
        if not year:
            summary["missing_year"] += 1
            pub_issues.append("missing_year")
        if not venue:
            summary["missing_venue"] += 1
            pub_issues.append("missing_venue")
        if not categories:
            summary["missing_categories"] += 1
            pub_issues.append("missing_categories")
        invalid_categories = [c for c in categories if c not in allowed]
        if invalid_categories:
            pub_issues.append(f"invalid_categories:{','.join(invalid_categories)}")
        if not source_members:
            summary["missing_source_members"] += 1
            pub_issues.append("missing_source_members")
        invalid_members = [m for m in source_members if m not in member_names]
        if invalid_members:
            pub_issues.append(f"invalid_source_members:{','.join(invalid_members)}")
        if thumbnail in ("", DEFAULT_THUMBNAIL, f"./{DEFAULT_THUMBNAIL}"):
            summary["default_thumbnails"] += 1
        if thumbnail and not thumbnail_exists(thumbnail):
            summary["broken_thumbnails"] += 1
            pub_issues.append("broken_thumbnail")

        verified = pub.get("metadata_verified") or {}
        if verified.get("source") == "openalex" and verified.get("status") == "matched":
            summary["openalex_matched"] += 1
        elif verified.get("status") == "unmatched":
            summary["openalex_unmatched"] += 1

        title_lower = title.lower()
        if "Chenjun Li" in source_members and ((year and year < 2024) or "visiopath" in title_lower):
            summary["chenjun_policy_violations"] += 1
            pub_issues.append("chenjun_policy_violation")

        if pub_issues:
            issues.append({
                "id": trim(pub.get("id")),
                "title": title,
                "issues": pub_issues,
            })

    duplicate_keys = {}
    for pub in publications:
        key = canonical_duplicate_key(trim(pub.get("title")))
        duplicate_keys.setdefault(key, []).append(trim(pub.get("title")))
    duplicates = [
        titles for titles in duplicate_keys.values()
        if len(set(titles)) > 1
    ]
    summary["duplicate_title_groups"] = len(duplicates)

    return {
        "generated_at": utc_now(),
        "summary": summary,
        "issues": issues,
        "duplicate_groups": duplicates,
    }


def absolute_url(url: str, base_url: str) -> str:
    if not url:
        return ""
    return urljoin(base_url, url)


def uses_default_thumbnail(pub: Dict[str, Any]) -> bool:
    thumbnail = trim(pub.get("thumbnail"))
    return thumbnail in ("", DEFAULT_THUMBNAIL, f"./{DEFAULT_THUMBNAIL}")


def uses_auto_thumbnail(pub: Dict[str, Any]) -> bool:
    thumbnail = trim(pub.get("thumbnail")).lstrip("./")
    source = trim(pub.get("thumbnail_source"))
    return source in AUTO_THUMBNAIL_SOURCES or thumbnail.startswith("images/publications/thumbnails/auto/")


def should_refresh_thumbnail(pub: Dict[str, Any], *, overwrite: bool, refresh_auto_thumbnails: bool) -> bool:
    return (
        overwrite
        or uses_default_thumbnail(pub)
        or (refresh_auto_thumbnails and uses_auto_thumbnail(pub))
    )


def is_probably_generic_image_url(url: str) -> bool:
    lower = url.lower()
    generic_markers = [
        "logo",
        "favicon",
        "sprite",
        "icon",
        "default",
        "placeholder",
        "publisher-logo",
        "site-logo",
        "profile",
        "avatar",
    ]
    return any(marker in lower for marker in generic_markers)


def arxiv_pdf_url(url: str) -> str:
    parsed = urlparse(url)
    if "arxiv.org" not in parsed.netloc:
        return ""
    path = parsed.path
    if path.startswith("/pdf/"):
        return url
    if path.startswith("/abs/"):
        paper_id = path.removeprefix("/abs/").strip("/")
        return f"https://arxiv.org/pdf/{paper_id}"
    return ""


def find_pdf_link(pub: Dict[str, Any], *, request_delay: float = 0.0) -> str:
    existing = trim(pub.get("pdf_link"))
    if existing:
        return existing

    url = trim(pub.get("url"))
    if url.lower().endswith(".pdf"):
        return url

    arxiv = arxiv_pdf_url(url)
    if arxiv:
        return arxiv

    candidates = [trim(pub.get("scholar_link")), url]
    for candidate in candidates:
        if not candidate:
            continue
        target = candidate
        if candidate.startswith("/"):
            target = urljoin("https://scholar.google.com", candidate)
        if "scholar.google." in urlparse(target).netloc:
            continue
        html = fetch_html(target)
        if request_delay:
            time.sleep(request_delay)
        if not html:
            continue
        soup = BeautifulSoup(html, "html.parser")
        for meta in soup.select("meta[content]"):
            key = " ".join(
                trim(meta.get(attr)).lower()
                for attr in ["name", "property"]
                if trim(meta.get(attr))
            )
            content = trim(meta.get("content"))
            if content and key in {"citation_pdf_url", "dc.identifier", "eprints.document_url"}:
                absolute = absolute_url(content, target)
                if absolute.lower().endswith(".pdf") or "pdf" in absolute.lower():
                    return absolute
        parsed_target = urlparse(target)
        if "openreview.net" in parsed_target.netloc and "id=" in parsed_target.query:
            return f"https://openreview.net/pdf?{parsed_target.query}"
        for link in soup.select("a[href]"):
            href = link.get("href", "")
            text = link.get_text(" ", strip=True).lower()
            absolute = absolute_url(href, target)
            if absolute.lower().endswith(".pdf") or "pdf" in text:
                return absolute
    return ""


def fit_cover(image: Any, size: Tuple[int, int] = (900, 600)) -> Any:
    image = image.convert("RGB")
    target_w, target_h = size
    src_w, src_h = image.size
    if not src_w or not src_h:
        return image
    scale = max(target_w / src_w, target_h / src_h)
    resized = image.resize((max(target_w, int(src_w * scale)), max(target_h, int(src_h * scale))), Image.LANCZOS)
    left = max(0, (resized.width - target_w) // 2)
    top = max(0, (resized.height - target_h) // 2)
    return resized.crop((left, top, left + target_w, top + target_h))


def image_quality_score(image: Any) -> int:
    if Image is None or ImageStat is None:
        return 0
    try:
        width, height = image.size
        if width < 220 or height < 140:
            return 0
        aspect = width / max(height, 1)
        if aspect < 0.35 or aspect > 5.0:
            return 0

        sample = image.convert("RGB")
        sample.thumbnail((128, 128))
        gray = sample.convert("L")
        stat = ImageStat.Stat(gray)
        mean = stat.mean[0]
        std = stat.stddev[0]
        hist = gray.histogram()
        total = max(sum(hist), 1)
        dark_fraction = sum(hist[:12]) / total
        light_fraction = sum(hist[244:]) / total
        if std < 9 or dark_fraction > 0.88 or light_fraction > 0.94:
            return 0

        entropy = 0.0
        for count in hist:
            if count:
                p = count / total
                entropy -= p * math.log2(p)

        rgb_stat = ImageStat.Stat(sample)
        color_spread = sum(rgb_stat.stddev) / 3
        area_score = min(width * height / 7000, 90)
        contrast_score = min(std * 3.2, 130)
        entropy_score = min(entropy * 24, 170)
        color_score = min(color_spread * 1.2, 70)
        whitespace_penalty = 55 if light_fraction > 0.82 else 0
        darkness_penalty = 45 if dark_fraction > 0.70 else 0
        return int(area_score + contrast_score + entropy_score + color_score - whitespace_penalty - darkness_penalty)
    except Exception:
        return 0


def pixmap_to_image(pix: Any) -> Optional[Any]:
    if Image is None:
        return None
    try:
        return Image.open(BytesIO(pix.tobytes("png"))).convert("RGB")
    except Exception:
        return None


def save_image_thumbnail(image: Any, out_path: Path, *, cover: bool = True) -> bool:
    if Image is None:
        return False
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        image = fit_cover(image) if cover else image.convert("RGB")
        if not cover:
            image.thumbnail((900, 600))
        image.save(out_path, format="JPEG", quality=84, optimize=True, progressive=True)
        return out_path.exists() and out_path.stat().st_size > 0
    except Exception as exc:
        print(f"warn: failed to save image thumbnail {out_path}: {exc}", file=sys.stderr)
        return False


def save_remote_image_thumbnail(url: str, out_path: Path) -> bool:
    if Image is None or not url or is_probably_generic_image_url(url):
        return False
    try:
        with requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT_SECONDS, stream=True) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").lower()
            if "image" not in content_type and not re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", url.lower()):
                return False
            total = 0
            chunks = []
            for chunk in response.iter_content(chunk_size=8192):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_IMAGE_BYTES:
                    raise RuntimeError(f"image exceeds max size: {url}")
                chunks.append(chunk)
        image = Image.open(BytesIO(b"".join(chunks))).convert("RGB")
        if image.width < 260 or image.height < 160:
            return False
        if image_quality_score(image) < REMOTE_IMAGE_MIN_SCORE:
            return False
        return save_image_thumbnail(image, out_path, cover=True)
    except Exception as exc:
        print(f"warn: failed to download page image {url}: {exc}", file=sys.stderr)
        return False


def find_page_image_link(pub: Dict[str, Any], *, request_delay: float = 0.0) -> str:
    url = trim(pub.get("url"))
    if not url or url.lower().endswith(".pdf"):
        return ""
    if "scholar.google." in urlparse(url).netloc:
        return ""
    html = fetch_html(url)
    if request_delay:
        time.sleep(request_delay)
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    keys = {
        "og:image",
        "og:image:url",
        "twitter:image",
        "twitter:image:src",
        "citation_image",
        "thumbnail",
    }
    for meta in soup.select("meta[content]"):
        key = " ".join(
            trim(meta.get(attr)).lower()
            for attr in ["property", "name", "itemprop"]
            if trim(meta.get(attr))
        )
        content = trim(meta.get("content"))
        if content and key in keys:
            absolute = absolute_url(content, url)
            if not is_probably_generic_image_url(absolute):
                return absolute
    for link in soup.select("link[href]"):
        rel = " ".join(link.get("rel", [])).lower() if isinstance(link.get("rel"), list) else trim(link.get("rel")).lower()
        if rel in {"image_src", "preload"}:
            absolute = absolute_url(trim(link.get("href")), url)
            if absolute and not is_probably_generic_image_url(absolute):
                return absolute
    return ""


def extract_page_image(pub: Dict[str, Any], *, request_delay: float = 0.0) -> str:
    if Image is None:
        return ""
    title = trim(pub.get("title")) or trim(pub.get("id")) or "publication"
    image_url = find_page_image_link(pub, request_delay=request_delay)
    if not image_url:
        return ""
    out_path = AUTO_THUMB_DIR / f"{slugify(title, 70)}_pageimage.jpg"
    if save_remote_image_thumbnail(image_url, out_path):
        return str(out_path.relative_to(ROOT))
    return ""


def load_font(size: int, *, bold: bool = False) -> Any:
    if ImageFont is None:
        return None
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Helvetica.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        try:
            if candidate and Path(candidate).exists():
                return ImageFont.truetype(candidate, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def wrapped_lines(draw: Any, text: str, font: Any, max_width: int, max_lines: int) -> List[str]:
    words = re.sub(r"\s+", " ", text).strip().split()
    lines: List[str] = []
    current = ""
    for word in words:
        trial = f"{current} {word}".strip()
        bbox = draw.textbbox((0, 0), trial, font=font)
        if bbox[2] - bbox[0] <= max_width or not current:
            current = trial
            continue
        lines.append(current)
        current = word
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and len(" ".join(words)) > len(" ".join(lines)):
        lines[-1] = lines[-1].rstrip(".,;:") + "..."
    return lines


def short_author_line(authors: str, max_authors: int = 4) -> str:
    names = [
        part.strip()
        for part in re.sub(r"\s+and\s+", ", ", authors or "", flags=re.IGNORECASE).split(",")
        if part.strip()
    ]
    if not names:
        return ""
    if len(names) <= max_authors:
        return ", ".join(names)
    return f"{', '.join(names[:2])}, ..., {names[-1]}"


def create_publication_card_thumbnail(pub: Dict[str, Any], categories: Dict[str, str]) -> str:
    if Image is None or ImageDraw is None:
        return ""

    title = trim(pub.get("title")) or "Publication"
    slug = slugify(title, 70)
    out_path = AUTO_THUMB_DIR / f"{slug}_card.jpg"
    primary = trim(pub.get("primary_category")) or (pub.get("categories") or ["other"])[0]
    dark, accent = CATEGORY_THEME_COLORS.get(primary, CATEGORY_THEME_COLORS["other"])
    image = Image.new("RGB", (900, 600), dark)
    draw = ImageDraw.Draw(image)

    overlay = Image.new("RGBA", (900, 600), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    # Subtle technical grid and accent geometry to keep generated fallbacks visually consistent.
    for x in range(0, 900, 60):
        odraw.line((x, 0, x, 600), fill="#ffffff22", width=1)
    for y in range(0, 600, 60):
        odraw.line((0, y, 900, y), fill="#ffffff22", width=1)
    odraw.polygon([(560, 0), (900, 0), (900, 600), (430, 600)], fill=accent + "55")
    odraw.ellipse((610, 110, 1040, 540), outline=accent + "88", width=6)
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(image)

    title_font = load_font(42, bold=True)
    meta_font = load_font(24)
    small_font = load_font(20, bold=True)

    label = categories.get(primary, primary.upper() if primary and len(primary) <= 4 else primary.title())
    year = trim(pub.get("year"))
    venue = trim(pub.get("venue"))
    authors = short_author_line(trim(pub.get("authors")))

    draw.rounded_rectangle((48, 48, 48 + 24 + len(label) * 14, 88), radius=8, fill=accent)
    draw.text((62, 57), label, fill="#101010", font=small_font)
    if year:
        draw.text((48, 108), year, fill="#ffffff", font=meta_font)

    y = 170
    for line in wrapped_lines(draw, title, title_font, 760, 4):
        draw.text((48, y), line, fill="#ffffff", font=title_font)
        y += 52

    footer = venue or authors or "Paetzold Lab"
    if authors and venue:
        footer = f"{venue} / {authors}"
    for line in wrapped_lines(draw, footer, meta_font, 760, 2):
        draw.text((48, min(y + 34, 520)), line, fill="#e9ecef", font=meta_font)
        y += 32

    if save_image_thumbnail(image, out_path, cover=False):
        return str(out_path.relative_to(ROOT))
    return ""


def download_pdf(url: str, path: Path) -> bool:
    if not url:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return True
    try:
        with requests.get(url, headers=REQUEST_HEADERS, timeout=45, stream=True) as response:
            response.raise_for_status()
            total = 0
            with path.open("wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > MAX_PDF_BYTES:
                        raise RuntimeError(f"PDF exceeds max size: {url}")
                    f.write(chunk)
        if path.stat().st_size <= 0:
            return False
        with path.open("rb") as f:
            if f.read(5) != b"%PDF-":
                raise RuntimeError(f"downloaded content is not a PDF: {url}")
        return True
    except Exception as exc:
        print(f"warn: failed to download PDF {url}: {exc}", file=sys.stderr)
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass
        return False


def pdf_cache_path(pub: Dict[str, Any]) -> Path:
    title = trim(pub.get("title")) or trim(pub.get("id")) or "publication"
    digest = hashlib.sha1(title.encode("utf-8")).hexdigest()[:10]
    return PDF_CACHE_DIR / f"{slugify(title, 70)}_{digest}.pdf"


def extract_pdf_text(path: Path, max_pages: int = 6) -> str:
    if fitz is None or not path.exists():
        return ""
    try:
        doc = fitz.open(path)
        pages = []
        for index in range(min(max_pages, doc.page_count)):
            pages.append(doc.load_page(index).get_text("text"))
        return re.sub(r"\s+", " ", " ".join(pages)).strip()
    except Exception as exc:
        print(f"warn: failed to extract text from {path}: {exc}", file=sys.stderr)
        return ""


def save_pixmap(pix: Any, out_path: Path) -> bool:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if Image is not None and out_path.suffix.lower() in {".jpg", ".jpeg"}:
            image = Image.open(BytesIO(pix.tobytes("png"))).convert("RGB")
            image.thumbnail((900, 600))
            image.save(out_path, format="JPEG", quality=82, optimize=True, progressive=True)
            return out_path.exists() and out_path.stat().st_size > 0

        if pix.alpha or pix.n >= 5:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        pix.save(str(out_path))
        return out_path.exists() and out_path.stat().st_size > 0
    except Exception:
        return False


def extract_representative_image(pdf_path: Path, pub: Dict[str, Any]) -> str:
    if fitz is None or not pdf_path.exists():
        return ""
    title = trim(pub.get("title")) or trim(pub.get("id")) or "publication"
    slug = slugify(title, 70)
    best: Tuple[int, Optional[Any]] = (0, None)

    try:
        doc = fitz.open(pdf_path)
        for page_index in range(min(5, doc.page_count)):
            page = doc.load_page(page_index)
            for image in page.get_images(full=True):
                try:
                    xref = image[0]
                    pix = fitz.Pixmap(doc, xref)
                    if pix.alpha or pix.n >= 5:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    candidate = pixmap_to_image(pix)
                    if candidate is None:
                        continue
                    score = image_quality_score(candidate)
                    if score > best[0]:
                        best = (score, candidate)
                except Exception:
                    continue

        if best[1] is not None and best[0] >= PDF_IMAGE_MIN_SCORE:
            out_path = AUTO_THUMB_DIR / f"{slug}_image.jpg"
            if save_image_thumbnail(best[1], out_path, cover=True):
                return str(out_path.relative_to(ROOT))
    except Exception as exc:
        print(f"warn: failed to extract image from {pdf_path}: {exc}", file=sys.stderr)
    return ""


def openai_chat_json(prompt: str, *, model: str) -> Optional[Dict[str, Any]]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("warn: OPENAI_API_KEY is not set; skipping LLM enrichment", file=sys.stderr)
        return None

    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    endpoint = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You enrich publication metadata for a medical AI lab website. "
                    "Return concise, factual JSON only."
                ),
            },
            {"role": "user", "content": prompt},
        ],
    }
    try:
        response = requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return json.loads(content)
    except Exception as exc:
        print(f"warn: LLM enrichment failed: {exc}", file=sys.stderr)
        return None


def build_llm_prompt(pub: Dict[str, Any], text: str, allowed_categories: Dict[str, str]) -> str:
    clipped_text = text[:12000]
    allowed = ", ".join(f"{key}={label}" for key, label in allowed_categories.items())
    return (
        "Enrich this publication for a lab website.\n"
        f"Allowed categories: {allowed}\n\n"
        "Return JSON with exactly these keys:\n"
        "- summary: 1-2 sentences, plain English, no hype\n"
        "- categories: array of allowed category keys only\n"
        "- primary_category: one allowed category key, preferably the best category\n"
        "- tags: 3-8 short technical tags\n"
        "- modality: short string or empty string\n"
        "- task: short string or empty string\n\n"
        f"Title: {trim(pub.get('title'))}\n"
        f"Authors: {trim(pub.get('authors'))}\n"
        f"Venue: {trim(pub.get('venue'))}\n"
        f"Year: {trim(pub.get('year'))}\n"
        f"Existing abstract: {trim(pub.get('abstract'))}\n\n"
        f"Paper text excerpt:\n{clipped_text}"
    )


def sanitize_llm_result(result: Dict[str, Any], allowed_categories: Dict[str, str]) -> Dict[str, Any]:
    allowed = set(allowed_categories.keys())
    categories = [
        c for c in result.get("categories", [])
        if isinstance(c, str) and c in allowed
    ]
    primary = result.get("primary_category")
    if primary not in allowed:
        primary = categories[0] if categories else None
    tags = [
        str(t).strip()
        for t in result.get("tags", [])
        if str(t).strip()
    ][:8]
    return {
        "summary": trim(result.get("summary"))[:700],
        "categories": categories,
        "primary_category": primary,
        "tags": tags,
        "modality": trim(result.get("modality"))[:120],
        "task": trim(result.get("task"))[:120],
    }


def enrich_publication(
    pub: Dict[str, Any],
    *,
    categories: Dict[str, str],
    download_pdfs: bool,
    use_page_images: bool,
    fallback_thumbnails: bool,
    use_llm: bool,
    model: str,
    request_delay: float,
    overwrite: bool,
    refresh_auto_thumbnails: bool,
) -> Dict[str, Any]:
    enriched = dict(pub)
    title = trim(enriched.get("title"))
    source_text = " ".join(
        part for part in [title, trim(enriched.get("abstract")), trim(enriched.get("summary"))] if part
    )

    pdf_path: Optional[Path] = None
    thumbnail_replaced = False
    if download_pdfs:
        pdf_link = find_pdf_link(enriched, request_delay=request_delay)
        if pdf_link:
            enriched["pdf_link"] = pdf_link
            pdf_path = pdf_cache_path(enriched)
            if download_pdf(pdf_link, pdf_path):
                enriched["pdf_local_path"] = str(pdf_path.relative_to(ROOT))
                pdf_text = extract_pdf_text(pdf_path)
                if pdf_text:
                    source_text = f"{source_text} {pdf_text}"
                    abstract_section = extract_abstract_section(pdf_text)
                    if overwrite or not trim(enriched.get("abstract")):
                        enriched["abstract"] = abstract_section or first_sentences(pdf_text, max_chars=1200)
                if should_refresh_thumbnail(
                    enriched,
                    overwrite=overwrite,
                    refresh_auto_thumbnails=refresh_auto_thumbnails,
                ):
                    thumbnail = extract_representative_image(pdf_path, enriched)
                    if thumbnail:
                        enriched["thumbnail"] = thumbnail
                        enriched["thumbnail_source"] = "pdf"
                        thumbnail_replaced = True
            else:
                thumbnail_replaced = False

    if (
        use_page_images
        and not thumbnail_replaced
        and should_refresh_thumbnail(
            enriched,
            overwrite=overwrite,
            refresh_auto_thumbnails=refresh_auto_thumbnails,
        )
    ):
        thumbnail = extract_page_image(enriched, request_delay=request_delay)
        if thumbnail:
            enriched["thumbnail"] = thumbnail
            enriched["thumbnail_source"] = "page-image"
            thumbnail_replaced = True

    if (
        fallback_thumbnails
        and not thumbnail_replaced
        and should_refresh_thumbnail(
            enriched,
            overwrite=overwrite,
            refresh_auto_thumbnails=refresh_auto_thumbnails,
        )
    ):
        thumbnail = create_publication_card_thumbnail(enriched, categories)
        if thumbnail:
            enriched["thumbnail"] = thumbnail
            enriched["thumbnail_source"] = "generated-card"

    llm_result: Optional[Dict[str, Any]] = None
    if use_llm and source_text:
        prompt = build_llm_prompt(enriched, source_text, categories)
        llm_result = openai_chat_json(prompt, model=model)

    if llm_result:
        clean = sanitize_llm_result(llm_result, categories)
        if clean["summary"] and (overwrite or not trim(enriched.get("summary"))):
            enriched["summary"] = clean["summary"]
        if clean["categories"] and (overwrite or not enriched.get("categories")):
            enriched["categories"] = clean["categories"]
        if clean["primary_category"] and (overwrite or not enriched.get("primary_category")):
            enriched["primary_category"] = clean["primary_category"]
        if clean["tags"]:
            enriched["llm_tags"] = clean["tags"]
        if clean["modality"]:
            enriched["modality"] = clean["modality"]
        if clean["task"]:
            enriched["task"] = clean["task"]
    else:
        inferred = keyword_categories(source_text)
        if inferred and (overwrite or not enriched.get("categories")):
            enriched["categories"] = inferred
        if not trim(enriched.get("summary")):
            enriched["summary"] = first_sentences(trim(enriched.get("abstract")) or source_text)

    categories_list = enriched.get("categories") or []
    if categories_list and not enriched.get("primary_category"):
        enriched["primary_category"] = categories_list[0]

    enriched["auto_enriched"] = {
        "at": utc_now(),
        "llm": bool(llm_result),
        "model": model if llm_result else "",
        "pdf_downloaded": bool(pdf_path and pdf_path.exists()),
    }
    return enriched


def enrich_publications(
    publications: List[Dict[str, Any]],
    *,
    categories: Dict[str, str],
    args: argparse.Namespace,
) -> List[Dict[str, Any]]:
    enriched: List[Dict[str, Any]] = []
    limit = args.limit if args.limit and args.limit > 0 else None
    enriched_count = 0

    for pub in publications:
        should_enrich = True
        if args.only_representative and not pub.get("representative"):
            should_enrich = False
        if args.only_missing_thumbnails:
            if not (
                uses_default_thumbnail(pub)
                or (args.refresh_auto_thumbnails and uses_auto_thumbnail(pub))
            ):
                should_enrich = False
        if limit is not None and enriched_count >= limit:
            should_enrich = False
        if should_enrich:
            enriched_count += 1
            print(f"enrich: {enriched_count} {trim(pub.get('title'))[:90]}")
            enriched.append(
                enrich_publication(
                    pub,
                    categories=categories,
                    download_pdfs=args.download_pdfs,
                    use_page_images=args.page_images,
                    fallback_thumbnails=args.fallback_thumbnails,
                    use_llm=args.llm,
                    model=args.openai_model,
                    request_delay=args.request_delay,
                    overwrite=args.overwrite,
                    refresh_auto_thumbnails=args.refresh_auto_thumbnails,
                )
            )
        else:
            enriched.append(pub)
    return enriched


def score_publication(pub: Dict[str, Any]) -> Tuple[int, int, int]:
    year = as_int(pub.get("year"))
    citations = as_int(pub.get("citations"))
    has_thumbnail = 1 if trim(pub.get("thumbnail")) not in ("", DEFAULT_THUMBNAIL, f"./{DEFAULT_THUMBNAIL}") else 0
    return (citations, year, has_thumbnail)


def mark_representative_publications(
    publications: List[Dict[str, Any]],
    members: List[LabMember],
    *,
    per_member: int = 3,
    max_featured: int = 10,
) -> List[Dict[str, Any]]:
    publications = apply_promotion_overrides(publications)
    by_member = {member.name: [] for member in members}
    for pub in publications:
        for member_name in pub.get("source_members") or []:
            if member_name in by_member:
                by_member[member_name].append(pub)

    representative_ids = set()
    representative_for: Dict[str, List[str]] = {}
    for member_name, pubs in by_member.items():
        include_ids = MANUAL_REPRESENTATIVE_INCLUDES.get(member_name, [])
        exclude_ids = set(MANUAL_REPRESENTATIVE_EXCLUDES.get(member_name, []))
        by_id = {publication_id(pub): pub for pub in pubs}
        selected: List[Dict[str, Any]] = []
        selected_ids = set()
        for pub_id in include_ids:
            if pub_id in by_id and pub_id not in exclude_ids:
                selected.append(by_id[pub_id])
                selected_ids.add(pub_id)
        if len(selected) > per_member:
            selected = selected[:per_member]
            selected_ids = {publication_id(pub) for pub in selected}
        for pub in sorted(pubs, key=score_publication, reverse=True):
            if len(selected) >= per_member:
                break
            pub_id = publication_id(pub)
            if pub_id in selected_ids or pub_id in exclude_ids:
                continue
            selected.append(pub)
            selected_ids.add(pub_id)
        for pub in selected:
            pub_id = publication_id(pub)
            representative_ids.add(pub_id)
            representative_for.setdefault(pub_id, []).append(member_name)

    for pub in publications:
        pub_id = publication_id(pub)
        if pub_id in representative_ids:
            pub["representative"] = True
            pub["representative_for"] = representative_for.get(pub_id, [])
        elif "representative" in pub:
            pub["representative"] = False
            pub.pop("representative_for", None)

    promoted = [
        pub for pub in publications
        if publication_id(pub) in PROMOTION_OVERRIDES
    ]
    promoted = sorted(promoted, key=lambda pub: as_int(pub.get("promotion_rank")))
    promoted_ids = {publication_id(pub) for pub in promoted}

    candidates = [
        pub for pub in publications
        if (pub.get("featured") or pub.get("representative"))
        and publication_id(pub) not in promoted_ids
        and publication_id(pub) not in DEPRIORITIZED_FEATURED_IDS
    ]
    candidates = sorted(candidates, key=score_publication, reverse=True)
    featured = (promoted + candidates)[:max_featured]
    featured_ids = {publication_id(pub) for pub in featured}

    for order, pub in enumerate(featured):
        pub["featured"] = True
        if publication_id(pub) in PROMOTION_OVERRIDES:
            pub["featuredOrder"] = as_int(PROMOTION_OVERRIDES[publication_id(pub)].get("featuredOrder"))
        else:
            pub["featuredOrder"] = order

    for pub in publications:
        pub_id = publication_id(pub)
        if pub_id not in featured_ids:
            pub["featured"] = False
            pub["featuredOrder"] = 999
    return apply_promotion_overrides(publications)


def build_output(
    source: Dict[str, Any],
    publications: List[Dict[str, Any]],
    *,
    config: Dict[str, Any],
) -> Dict[str, Any]:
    output = dict(source)
    output["last_updated"] = utc_now()
    output["categories"] = config.get("categories") or source.get("categories") or {}
    output["publications"] = publications
    output["automation"] = {
        "pipeline": "scripts/research_pipeline.py",
        "updated_at": utc_now(),
        "members_config": str(DEFAULT_CONFIG.relative_to(ROOT)),
    }
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect and enrich lab publications.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--preview-output", type=Path, default=DEFAULT_PREVIEW)
    parser.add_argument("--audit-output", type=Path, default=ROOT / "data" / "publications.audit.json")
    parser.add_argument("--collect-scholar", action="store_true", help="Collect publications from configured Google Scholar profiles.")
    parser.add_argument("--normalize", action="store_true", help="Normalize members, categories, duplicates, and site-facing metadata.")
    parser.add_argument("--verify-openalex", action="store_true", help="Verify/fill DOI, venue, year, and URL metadata using OpenAlex title matching.")
    parser.add_argument("--audit", action="store_true", help="Write a publication quality audit report.")
    parser.add_argument("--enrich", action="store_true", help="Enrich publication metadata.")
    parser.add_argument("--representative", action="store_true", help="Mark representative publications per lab member.")
    parser.add_argument("--download-pdfs", action="store_true", help="Find/download PDFs and extract text/images.")
    parser.add_argument("--page-images", action="store_true", help="Try publication landing-page og/twitter images for missing thumbnails.")
    parser.add_argument("--fallback-thumbnails", action="store_true", help="Generate publication-card thumbnails when no paper image is available.")
    parser.add_argument("--only-representative", action="store_true", help="Only enrich publications marked as representative.")
    parser.add_argument("--only-missing-thumbnails", action="store_true", help="Only enrich publications that still use the default thumbnail.")
    parser.add_argument("--refresh-auto-thumbnails", action="store_true", help="Refresh thumbnails previously generated by this pipeline while preserving manual thumbnails.")
    parser.add_argument("--llm", action="store_true", help="Use an OpenAI-compatible chat completion API for summaries/tags.")
    parser.add_argument("--write", action="store_true", help="Write to --output instead of preview output.")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing fields when enrichment finds better values.")
    parser.add_argument("--limit", type=int, default=0, help="Only enrich the first N publications; 0 means all.")
    parser.add_argument("--member", default="", help="Restrict Scholar collection to one member name or Scholar ID.")
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--request-delay", type=float, default=REQUEST_DELAY_SECONDS)
    parser.add_argument("--openai-model", default=os.getenv("OPENAI_MODEL", "gpt-4o-mini"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_json(args.config)
    source = load_json(args.input)
    categories = config.get("categories") or source.get("categories") or {}
    members = load_members(config)
    publications = list(source.get("publications", []))

    if not any([
        args.collect_scholar,
        args.enrich,
        args.representative,
        args.normalize,
        args.verify_openalex,
        args.audit,
        args.page_images,
        args.fallback_thumbnails,
    ]):
        print("Nothing to do. Use --collect-scholar, --normalize, --verify-openalex, --audit, --enrich, and/or --representative.")
        return 2

    if args.collect_scholar:
        incoming = collect_from_scholar(
            members,
            max_pages=args.max_pages,
            page_size=args.page_size,
            request_delay=args.request_delay,
            member_filter=args.member or None,
        )
        before = len(publications)
        publications = merge_publications(publications, incoming, overwrite=args.overwrite)
        print(f"merge: {before} existing + {len(incoming)} collected -> {len(publications)} total")

    if args.normalize:
        before = len(publications)
        publications = normalize_publication_records(
            publications,
            members=members,
            allowed_categories=categories,
            dedupe=True,
        )
        print(f"normalize: {before} -> {len(publications)} site publications")

    if args.verify_openalex:
        publications = verify_publications_with_openalex(
            publications,
            request_delay=args.request_delay,
            limit=args.limit,
        )
        if args.normalize:
            publications = normalize_publication_records(
                publications,
                members=members,
                allowed_categories=categories,
                dedupe=True,
            )

    if args.representative:
        publications = mark_representative_publications(publications, members)

    if args.enrich:
        publications = enrich_publications(publications, categories=categories, args=args)
        if args.normalize:
            publications = normalize_publication_records(
                publications,
                members=members,
                allowed_categories=categories,
                dedupe=True,
            )

    output = build_output(source, publications, config=config)
    target = args.output if args.write else args.preview_output
    write_json_atomic(target, output)
    print(f"wrote: {target.relative_to(ROOT) if target.is_relative_to(ROOT) else target}")
    if args.audit:
        report = audit_publications(
            output.get("publications", []),
            members=members,
            allowed_categories=categories,
        )
        write_json_atomic(args.audit_output, report)
        print(f"audit: {args.audit_output.relative_to(ROOT) if args.audit_output.is_relative_to(ROOT) else args.audit_output}")
    if not args.write:
        print("dry-run: production data/publications.json was not modified. Re-run with --write to publish.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
