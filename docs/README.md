# Documentation

The documentation site for Clear Ideas Consent Analytics: the browser library, the collector
library and the standalone collector. It's built with [VitePress](https://vitepress.dev) from
the Markdown files in this folder, which also read fine on GitHub.

```sh
npm ci --prefix docs
npm run docs:dev        # http://127.0.0.1:5173, reloads as you edit
npm run docs:build      # static site in docs/.vitepress/dist
npm run docs:preview    # serve the built site
```

| Folder | Contents |
| --- | --- |
| `index.md`, `getting-started.md`, `concepts.md`, `playground.md` | Overview, quick start, core concepts, the playground |
| `browser/` | The browser library (`@clearideas/consent-analytics`) |
| `server/` | The collector library (`@clearideas/consent-analytics-server`) and the standalone collector |
| `api-contract.md` | The collector API (v1), for writing your own collector |
| `design/` | Design notes and project history (not part of the site) |
| `.vitepress/` | Site configuration and theme |
| `public/` | Logo, icons and the Inter font (served from the site, no third-party requests) |

Writing guidelines:

- Describe what the software does, with examples that work. Check defaults and behavior in
  the code (`src/`, `server/src/`, `collector/src/`) before writing them down.
- Link between pages with relative links (`./consent.md`); link to repository files outside
  `docs/` with GitHub URLs (the site can't serve them).
- Don't describe the project as compliant with a law or as certified; describe what it does.
- `npm run docs:build` fails on dead links: run it before committing.

## Deployment

[The public site](https://content-analytics.clearideas.com/) is built by the
`deploy-docs.yml` workflow on `main`. Run the workflow from `main` to redeploy
manually. The separate CI build checks documentation changes on pull requests.

`infrastructure/docs-hosting.yml` defines a private S3 bucket and a CloudFront
distribution in the Clear Ideas AWS account. Supply a DNS-validated ACM
certificate for the site in `us-east-1`. Keep the ACM validation record and the
site CNAME in the Cloudflare zone as DNS-only records.

The GitHub `documentation` environment permits only `main`. Set
`AWS_ROLE_ARN`, `DOCS_S3_BUCKET` and `CLOUDFRONT_DISTRIBUTION_ID` from the
CloudFormation stack outputs. GitHub uses OIDC to assume the role.
