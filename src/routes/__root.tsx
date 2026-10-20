import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        title: 'Transjakarta Live – Lacak Posisi Bus Real-Time | Tije',
      },
      {
        name: 'description',
        content:
          'Lacak posisi bus Transjakarta secara langsung di peta. Lihat bus BRT, Mikrotrans dan rute lainnya bergerak real-time, lengkap dengan rute dan halte.',
      },
      {
        name: 'keywords',
        content:
          'transjakarta live, lacak bus transjakarta, posisi bus real-time, tracking transjakarta, peta transjakarta, rute transjakarta, halte transjakarta',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Tije' },
      { property: 'og:locale', content: 'id_ID' },
      {
        property: 'og:title',
        content: 'Transjakarta Live – Lacak Posisi Bus Real-Time',
      },
      {
        property: 'og:description',
        content:
          'Lihat bus Transjakarta bergerak langsung di peta, lengkap dengan rute dan halte.',
      },
      { property: 'og:url', content: 'https://tije.info/' },
      // ponytail: square app icon, swap for a 1200x630 map screenshot and a
      // summary_large_image card when one exists.
      { property: 'og:image', content: 'https://tije.info/icon-512.png' },
      { property: 'og:image:width', content: '512' },
      { property: 'og:image:height', content: '512' },
      { property: 'og:image:alt', content: 'Logo Info Tije' },
      { name: 'twitter:card', content: 'summary' },
      {
        name: 'twitter:title',
        content: 'Transjakarta Live – Lacak Posisi Bus Real-Time',
      },
      {
        name: 'twitter:description',
        content:
          'Lihat bus Transjakarta bergerak langsung di peta, lengkap dengan rute dan halte.',
      },
      { name: 'twitter:image', content: 'https://tije.info/icon-512.png' },
      // Installable from the browser menu ("Add to Home Screen") and opened
      // without browser chrome; iOS reads its own meta tags for that.
      { name: 'theme-color', content: '#ffffff' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
      { name: 'apple-mobile-web-app-title', content: 'Tije' },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        type: 'image/png',
        href: '/favicon.png',
      },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ],
    scripts: [
      {
        // Microsoft Clarity analytics
        children: `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","yxggzxrs1j");`,
      },
      // Google Analytics (gtag.js)
      {
        async: true,
        src: 'https://www.googletagmanager.com/gtag/js?id=G-DTXJCB3P5R',
      },
      {
        children: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-DTXJCB3P5R');`,
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
})

/** Page for any URL the router doesn't know, with a way back to the map. */
function NotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="m-0 text-4xl font-extrabold tracking-tight">
        Halaman tidak ditemukan
      </h1>
      <Link
        to="/"
        className="flex h-12 items-center bg-[var(--accent)] px-5 font-bold text-[var(--accent-ink)] no-underline"
      >
        Kembali ke peta
      </Link>
    </main>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <head>
        <HeadContent />
      </head>
      <body className="relative h-dvh overflow-hidden font-sans antialiased [overflow-wrap:anywhere] selection:bg-[var(--accent)] selection:text-[var(--accent-ink)]">
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
