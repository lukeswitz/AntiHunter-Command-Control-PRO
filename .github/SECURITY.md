# Security Policy

AntiHunter Command & Control PRO is currently in a **beta** state and has not completed a formal penetration test. We strongly recommend running the stack on trusted networks only. That said, we welcome responsible disclosure of security issues so we can close the gaps before a stable release.

## Supported Versions

| Version branch        | Supported? | Notes                                                                                 |
| --------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `main`                | ✅         | Actively developed; security fixes land here first.                                   |
| Release tags          | ⚠️         | Beta snapshots only. Please update to the latest `main` build.                        |
| Forks / custom builds | ❌         | Out of scope unless the issue reproduces on an unmodified build from this repository. |

## Reporting a Vulnerability

1. **Open a private advisory draft** from the repository’s [GitHub Security Advisories](https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO/security/advisories) page or send a direct message via the repository owner’s GitHub profile (`@TheRealSirHaXalot`) with the subject line `AHCC SECURITY REPORT`.
2. Include the details listed in the section below so we can reproduce the issue quickly.
3. If you prefer encrypted communication, request our PGP key through the GitHub profile message and we will establish an encrypted channel.
4. We aim to acknowledge new reports within **3 business days** and provide a triage status or mitigation plan within **7 business days**. Complex issues may take longer; we will keep you updated.
5. Please do **not** publicly disclose, blog, or share proof‑of‑concept code until we confirm a fix is available or we mutually agree on a disclosure date.

### What to Include

- A concise description of the issue and the potential impact (e.g., RCE, privilege escalation, data disclosure).
- Steps to reproduce or a proof of concept.
- The commit hash or release tag you tested against.
- Affected configuration (OS, browser, deployment profile, environment variables, etc.).
- Any temporary mitigations you observed.

Submissions that follow this format allow us to resolve issues faster.

## Scope

In scope:

- Code in this repository (`apps/backend`, `apps/frontend`, `apps/shared`, infra scripts).
- Default Docker/docker-compose files shipped with the project.
- Prisma schema, migrations, and serial/MQTT ingest code.

Out of scope:

- Social engineering, phishing, or physical attacks.
- Findings in third‑party services, dependencies, or infrastructure that we do not control.
- Denial-of-service or volumetric attacks that rely solely on traffic amplification.
- Issues requiring root/admin access to the host or modification of environment variables beyond the documented configuration.
- Any vulnerability discovered in forked or modified versions that diverge from the upstream `main` branch.

If your research affects an upstream dependency (e.g., Prisma, NestJS, Leaflet), please disclose it directly to that project. We will still appreciate a heads-up so we can track the fix.

## Coordinated Disclosure & Safe Harbor

- Acting in good faith and within this policy will not lead to legal action against you. This includes testing, reporting, and discussing vulnerabilities with us privately.
- Avoid accessing, modifying, or destroying user data. If you encounter data owned by others, stop testing immediately and notify us.
- Limit automated scanning to the minimum necessary for verification. Brute force, spam, or resource exhaustion attacks are not permitted.
- Give us a reasonable time to remediate (minimum 30 days unless otherwise agreed) before making details public.

## Credit & Recognition

We are happy to acknowledge researchers who responsibly disclose issues, subject to your consent and the severity of the finding. Let us know if you would like to be credited in release notes or advisories.

## Need Help?

- For general questions or clarifications about this policy, use the repository owner’s GitHub profile to send us a message or open a draft advisory.
- To report an incident involving hosted AntiHunter deployments, also notify your internal security contacts—this project is distributed software and you remain responsible for your own perimeter controls.

Thank you for helping keep AntiHunter Command & Control PRO safe for operators.
