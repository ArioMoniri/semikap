import { useCallback, useState } from 'react';
import {
  Layout as LayoutIcon,
  Grid3x3,
  Columns3,
  Rows3,
  Square,
  Box as BoxIcon,
  Crosshair as CrosshairIcon,
} from 'lucide-react';
import type { ViewerHandle } from './Viewer';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { cn } from '../lib/ui/cn';

type SliceMode = 'multi' | 'axial' | 'coronal' | 'sagittal' | 'render';
type MultiLayout = 'auto' | 'row' | 'column' | 'grid';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

/**
 * Viewer presentation controls. Mirrors NiiVue's slice/render mode + the
 * multi-plane tile arrangement, plus a few visual toggles. All settings
 * apply live — no reload required. Defaults match NiivueViewer's
 * constructor (multi mode, auto layout, orient cube off, 3D crosshair on).
 */
export function LayoutPanel({ viewerRef }: Props) {
  const [sliceMode, setSliceMode] = useState<SliceMode>('multi');
  const [layout, setLayout] = useState<MultiLayout>('auto');
  const [orientCube, setOrientCubeState] = useState(false);
  const [colorbar, setColorbarState] = useState(false);
  const [crosshair3D, setCrosshair3DState] = useState(true);
  const [radiological, setRadiologicalState] = useState(false);

  const apply = useCallback(<T,>(setter: (v: T) => void, fn: ((v: T) => void) | undefined) =>
    (v: T) => {
      setter(v);
      fn?.(v);
    },
  []);

  const setSlice = (m: SliceMode) => {
    setSliceMode(m);
    viewerRef.current?.setSliceMode(m);
  };
  const setLayoutChoice = (l: MultiLayout) => {
    setLayout(l);
    viewerRef.current?.setMultiplanarLayout(l);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <LayoutIcon className="h-4 w-4 text-tamias-accent" /> Layout
          </CardTitle>
          <CardDescription>How the viewer presents the volume.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">View</div>
          <div className="grid grid-cols-5 gap-1">
            <ModeBtn label="MPR + 3D" icon={<Grid3x3 className="h-3.5 w-3.5" />} active={sliceMode === 'multi'} onClick={() => setSlice('multi')} />
            <ModeBtn label="Axial" icon={<Square className="h-3.5 w-3.5" />} active={sliceMode === 'axial'} onClick={() => setSlice('axial')} />
            <ModeBtn label="Coronal" icon={<Square className="h-3.5 w-3.5" />} active={sliceMode === 'coronal'} onClick={() => setSlice('coronal')} />
            <ModeBtn label="Sagittal" icon={<Square className="h-3.5 w-3.5" />} active={sliceMode === 'sagittal'} onClick={() => setSlice('sagittal')} />
            <ModeBtn label="3D" icon={<BoxIcon className="h-3.5 w-3.5" />} active={sliceMode === 'render'} onClick={() => setSlice('render')} />
          </div>
        </div>

        {sliceMode === 'multi' && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Arrangement</div>
            <div className="grid grid-cols-4 gap-1">
              <ModeBtn label="Auto" active={layout === 'auto'} onClick={() => setLayoutChoice('auto')} />
              <ModeBtn label="Row" icon={<Rows3 className="h-3.5 w-3.5" />} active={layout === 'row'} onClick={() => setLayoutChoice('row')} />
              <ModeBtn label="Col" icon={<Columns3 className="h-3.5 w-3.5" />} active={layout === 'column'} onClick={() => setLayoutChoice('column')} />
              <ModeBtn label="2×2" icon={<Grid3x3 className="h-3.5 w-3.5" />} active={layout === 'grid'} onClick={() => setLayoutChoice('grid')} />
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Overlays</div>
          <div className="grid grid-cols-2 gap-1">
            <Toggle
              label="Orientation cube"
              icon={<BoxIcon className="h-3.5 w-3.5" />}
              on={orientCube}
              onClick={() => apply(setOrientCubeState, viewerRef.current?.setOrientCube)(!orientCube)}
            />
            <Toggle
              label="Colorbar"
              on={colorbar}
              onClick={() => apply(setColorbarState, viewerRef.current?.setColorbar)(!colorbar)}
            />
            <Toggle
              label="3D crosshair"
              icon={<CrosshairIcon className="h-3.5 w-3.5" />}
              on={crosshair3D}
              onClick={() => apply(setCrosshair3DState, viewerRef.current?.set3DCrosshair)(!crosshair3D)}
            />
            <Toggle
              label="Radiological"
              on={radiological}
              onClick={() => apply(setRadiologicalState, viewerRef.current?.setRadiologicalConvention)(!radiological)}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ModeBtn({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? 'ink' : 'outline'}
      size="sm"
      onClick={onClick}
      className={cn(
        'h-auto flex-col gap-0.5 px-1 py-1.5 text-[10px] leading-tight',
        active ? '' : 'text-slate-700 dark:text-slate-200'
      )}
      title={label}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}

function Toggle({
  label,
  icon,
  on,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={on ? 'ink' : 'outline'}
      size="sm"
      onClick={onClick}
      className={cn(
        'h-7 justify-start gap-1.5 px-2 text-[11px]',
        on ? '' : 'text-slate-700 dark:text-slate-200'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}
