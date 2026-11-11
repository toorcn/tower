import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { store, useStore } from './store';
import { Scene } from './scene/model';
import { Renderer } from './scene/renderer';
import { AlertCard, Feed, Roster, Timeline, activeCollision, useNow } from './panels';
import './styles.css';

const scene = new Scene();
store.sink = scene;

function usePresentation() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement)) setOn(v => !v); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { document.body.classList.toggle('presenting', on); }, [on]);
  return on;
}

function Constellation({ presenting }: { presenting: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer>(null);
  useEffect(() => {
    const r = new Renderer(ref.current!, scene);
    renderer.current = r;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { r.view.reduced = media.matches; };
    sync(); media.addEventListener('change', sync);
    const resize = () => r.resize();
    resize(); window.addEventListener('resize', resize);
    r.start();
    // Exposed for the performance and layout checks.
    (window as unknown as { __tower: unknown }).__tower = { scene, renderer: r };
    return () => { r.stop(); window.removeEventListener('resize', resize); media.removeEventListener('change', sync); };
  }, []);
  useEffect(() => {
    const r = renderer.current; if (!r) return;
    r.view.presenting = presenting;
    const narrow = window.innerWidth < 900;
    r.padding = presenting ? { left: 210, right: 260, top: 130, bottom: 36 } : narrow ? { left: 20, right: 20, top: 90, bottom: 40 } : { left: 300, right: 360, top: 150, bottom: 56 };
    r.resize();
  }, [presenting]);
  return <canvas ref={ref} className="sky" />;
}

function App() {
  const { tower, panel, connected } = useStore();
  const presenting = usePresentation();
  const now = useNow();
  const collision = activeCollision(panel, now);
  return (
    <>
      <Constellation presenting={presenting} />
      <Roster agents={tower.agents} panel={panel} connected={connected} />
      <Feed panel={panel} agents={tower.agents} collision={collision} />
      <AlertCard collision={collision} panel={panel} agents={tower.agents} />
      <Timeline panel={panel} />
    </>
  );
}

store.start();
createRoot(document.getElementById('root')!).render(<App />);
