import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal, Tooltip } from 'antd';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import { FilePreview } from '@/shared/ui/FilePreview';
import type { Artifact } from '@/shared/types/workitem';
import { getArtifactDownloadUrl, getArtifactPreviewBlob } from '../api';
import { sameTypeArtifactSequence } from '../artifactGrouping';
import './ArtifactPreviewModal.css';

interface ArtifactPreviewModalProps {
  open: boolean;
  artifact: Artifact | null;
  artifacts?: Artifact[];
  onClose: () => void;
}

export function ArtifactPreviewModal({ open, artifact, artifacts, onClose }: ArtifactPreviewModalProps) {
  const { t } = useTranslation('workitem');
  const [current, setCurrent] = useState<Artifact | null>(artifact);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => { if (!open) setFullscreen(false); }, [open]);
  useEffect(() => {
    if (!open || !fullscreen) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', restore);
    return () => document.removeEventListener('keydown', restore);
  }, [open, fullscreen]);
  const sequence = useMemo(() => (artifact && artifacts ? sameTypeArtifactSequence(artifacts, artifact) : []), [artifact, artifacts]);
  const shown = current ?? artifact;
  const index = shown ? sequence.findIndex(item => item.id === shown.id) : -1;
  const canNavigate = sequence.length > 1 && index >= 0;
  const id = shown?.id;
  const loadBlob = useCallback(() => getArtifactPreviewBlob(id!), [id]);
  const goTo = (next: number) => { if (next >= 0 && next < sequence.length) setCurrent(sequence[next]); };
  useEffect(() => { setCurrent(open ? artifact : null); }, [artifact, open]);
  useEffect(() => {
    let cancelled = false;
    setDownloadUrl(null);
    if (open && id != null) {
      getArtifactDownloadUrl(id).then(url => { if (!cancelled) setDownloadUrl(url); }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [id, open]);
  useEffect(() => {
    if (!open || !canNavigate) return;
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      goTo(event.key === 'ArrowLeft' ? index - 1 : index + 1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, canNavigate, index, sequence]);

  // footer 仅保留同类型翻页；下载在官方头部按钮已提供。
  const footer = canNavigate ? [
    <Button key="previous" onClick={() => goTo(index - 1)} disabled={index <= 0}>{t('artifacts.previous')}</Button>,
    <span key="position" aria-live="polite">{t('artifacts.position', { current: index + 1, total: sequence.length })}</span>,
    <Button key="next" onClick={() => goTo(index + 1)} disabled={index >= sequence.length - 1}>{t('artifacts.next')}</Button>,
  ] : null;

  const fullscreenLabel = t(fullscreen ? 'detail.exitFullscreen' : 'detail.fullscreen');
  const filename = shown?.name ?? t('artifacts.preview');
  return <Modal title={<div className="aw-artifact-preview-title">
    <AwStrokeIcon name="file" size={14} />
    <span className="aw-artifact-preview-name" title={filename}>{filename}</span>
    {downloadUrl && <Tooltip title={t('artifacts.download')}>
      <Button size="middle" aria-label={t('artifacts.download')} icon={<AwStrokeIcon name="dl" />}
        href={downloadUrl} target="_blank" rel="noreferrer" />
    </Tooltip>}
    <Tooltip title={fullscreenLabel}>
      <Button size="middle"
        aria-label={fullscreenLabel} aria-pressed={fullscreen}
        icon={<AwStrokeIcon name="fullscreen" />}
        onClick={() => setFullscreen(value => !value)} />
    </Tooltip>
  </div>} className={`aw-artifact-preview-modal${fullscreen ? ' is-fullscreen' : ''}`}
    open={open} onCancel={onClose} keyboard={!fullscreen} width={fullscreen ? '100vw' : 880} forceRender
    footer={footer}>
    {open && shown && <FilePreview name={shown.name} size={shown.size} loadBlob={loadBlob} />}
  </Modal>;
}
