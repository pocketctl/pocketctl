export interface RenderedDiagram {
  svg: string
  width: number
  height: number
}
type DiagramRuntime = { render(source: string, dark: boolean): Promise<RenderedDiagram> }

declare global {
  interface Window { PocketDiagram?: DiagramRuntime }
}

let pending: Promise<DiagramRuntime> | undefined

export function loadDiagramRuntime(): Promise<DiagramRuntime> {
  if (window.PocketDiagram) return Promise.resolve(window.PocketDiagram)
  if (pending) return pending
  pending = new Promise<DiagramRuntime>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = import.meta.env.BASE_URL + 'diagram/runtime.js'
    const failed = () => {
      script.remove()
      reject(new Error('Diagram renderer unavailable'))
    }
    script.onload = () => window.PocketDiagram ? resolve(window.PocketDiagram) : failed()
    script.onerror = failed
    document.head.append(script)
  }).catch(error => {
    pending = undefined
    throw error
  })
  return pending
}
