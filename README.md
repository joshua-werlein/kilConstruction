<div align="center">

# 🏠 KIL Construction

### Serverless construction website · Galleries · Reviews · Custom administration

[![Live Website](https://img.shields.io/badge/Live_Site-kilcon.work-111827?style=for-the-badge)](https://kilcon.work)
[![Astro](https://img.shields.io/badge/Astro-5-BC52EE?style=flat-square&logo=astro&logoColor=white)](https://astro.build/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers_%C2%B7_D1_%C2%B7_R2-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)
![Status](https://img.shields.io/badge/Status-Production-2EA44F?style=flat-square)
[![License](https://img.shields.io/badge/License-Proprietary-5B5B5B?style=flat-square)](LICENSE)

**[🌐 Live Site](https://kilcon.work)** · **[📸 Project Gallery](https://kilcon.work/projects)** · **[GitHub](https://github.com/joshua-werlein/kilConstruction)** · **[👨‍💻 Developer Portfolio](https://joshuawerlein.com)**

</div>

---

## ✨ Overview

A production website and custom content platform built for a construction business. Its owner can organize project imagery, manage customer reviews, and maintain public content without editing code or relying on a third-party CMS.

The Astro site uses two Cloudflare Workers in this repository. The gallery Worker handles media, reviews, and Facebook events. The contact Worker verifies Turnstile challenges and delivers messages through Resend.

## 🚀 Features

| Area | What it does |
| :--- | :--- |
| 🖼️ **Project galleries** | Categorized project and service pages, uploads, image management, and responsive presentation |
| 🔐 **Admin dashboard** | Authenticated content administration with signed sessions and protected mutations |
| ⭐ **Customer reviews** | Review submission, moderation, featured reviews, and private review-photo storage |
| ☁️ **Cloud media** | R2 public gallery storage alongside separately restricted customer media |
| 📩 **Contact workflow** | Cloudflare Turnstile checks and Resend delivery through a separate Worker |
| 📘 **Facebook integration** | Signed Meta webhook handling, deduplication, new-post import tooling, and admin preview/reconciliation workflows |
| 🛡️ **Security controls** | Input checks, scoped media access, rate limits, and regression tests for path/URL variations |

## 🧩 Architecture

```mermaid
flowchart TB
    A[Astro website] --> B[Gallery + Reviews Worker]
    A --> C[Contact Worker]
    B --> D[(D1)]
    B --> E[(R2 public galleries)]
    B --> F[(R2 private customer media)]
    C --> G[Turnstile + Resend]
    H[Meta Page webhook] --> B
```

| Source | Responsibility |
| :--- | :--- |
| [Astro application](src/) | Public pages, admin sign-in, and same-origin API routes |
| [Gallery and reviews Worker](workers/kilcon-gallery-worker/) | D1 records, R2 media, moderation, and Facebook imports |
| [Contact Worker](workers/kilcon-contact/) | Turnstile verification and Resend delivery |

> **Deployment boundary:** The Astro site and two Workers deploy separately. A site push does not automatically redeploy the backend Workers.

## 🔎 Media and Facebook integration

The gallery Worker validates signed admin sessions for privileged operations. Project images and private review uploads use separate R2 storage. The review photo endpoint requires approval for public viewing and authorizes admins to inspect pending submissions.

Production receives signature-verified Meta webhooks and deduplicates eligible new-post imports. Broader album discovery and historical import are disabled in the documented production configuration. The admin preview supports reviewing matches before a historical import is considered.

<details>
<summary><strong>Implementation and rollout details</strong></summary>

- [Gallery and review access checks](workers/kilcon-gallery-worker/src/index.js)
- [Webhook verification and imports](docs/facebook-webhook.md)
- [Album discovery, preview, and release gates](docs/facebook-album-implementation.md)
- [Verified production flags](docs/security-release-2026-11-19.md)

</details>

## 📷 Screenshots

| Homepage | Project gallery |
| :---: | :---: |
| [<img src="docs/screenshots/homepage.png" alt="KIL Construction homepage" width="420">](docs/screenshots/homepage.png) | [<img src="docs/screenshots/projectsGallery.png" alt="Public construction project gallery" width="420">](docs/screenshots/projectsGallery.png) |

| Admin dashboard | Admin media management |
| :---: | :---: |
| [<img src="docs/screenshots/adminDashboard.png" alt="Authenticated admin dashboard with gallery and review tools" width="420">](docs/screenshots/adminDashboard.png) | [<img src="docs/screenshots/manageImages.png" alt="Admin media management search, folder list, and controls" width="420">](docs/screenshots/manageImages.png) |

<details>
<summary><strong>More screenshots</strong></summary>

| Review moderation | Contact page |
| :---: | :---: |
| [<img src="docs/screenshots/manageReviews.png" alt="Review moderation screen with filters and review actions" width="420">](docs/screenshots/manageReviews.png) | [<img src="docs/screenshots/contactPage.png" alt="KIL Construction public contact page" width="420">](docs/screenshots/contactPage.png) |

</details>

## 💻 Development

The site uses **Astro 5**. See [package.json](package.json) for dependencies and commands.

```bash
npm ci
npm run dev
npm run build
npm run test:site
npm run test:gallery-worker
```

Cloudflare account access, Worker bindings, D1 migrations, R2 buckets, and secrets are required for a fully functional deployment. **Never run production migrations or historical imports as part of README maintenance.**

## 📜 License and authorship

The code and client materials are **proprietary**. The repository is available for technical review, not as a grant of permission to copy or reuse it. See [LICENSE](LICENSE).

**Developed and maintained by Joshua Werlein** · [Portfolio](https://joshuawerlein.com) · [GitHub](https://github.com/joshua-werlein)
