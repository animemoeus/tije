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
        title: 'Rute Transjakarta',
      },
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
        type: 'image/svg+xml',
        href: '/favicon.svg',
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
