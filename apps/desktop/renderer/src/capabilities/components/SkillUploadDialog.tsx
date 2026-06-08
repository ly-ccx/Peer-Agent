import { useCallback, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';

export function SkillUploadDialog({
    onClose,
    onDone,
}: {
    readonly onClose: () => void;
    readonly onDone: () => void;
}) {
    const [file, setFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showBanner, setShowBanner] = useState(true);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0] ?? null;
        setFile(selected);
        setError(null);
    }, []);

    const handleUpload = useCallback(async () => {
        if (!file) return;
        setUploading(true);
        setError(null);
        try {
            const arrayBuffer = await file.arrayBuffer();
            const base64 = btoa(
                new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
            );
            await clientApi.uploadSkill(base64);
            onDone();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : '上传失败');
        } finally {
            setUploading(false);
        }
    }, [file, onDone]);

    return (
        <div className="skill-upload-overlay" onClick={onClose}>
            <div className="skill-upload-dialog" onClick={(e) => e.stopPropagation()}>
                <header>
                    <h3>上传技能</h3>
                    <button type="button" className="skill-upload-close" onClick={onClose}>×</button>
                </header>

                {showBanner && (
                    <div className="skill-upload-banner">
                        <span className="skill-upload-banner-icon">i</span>
                        <span>个人技能为仅供个人在本地安装使用的技能</span>
                        {/* <button type="button" className="skill-upload-banner-close" onClick={() => setShowBanner(false)}>×</button> */}
                    </div>
                )}

                <div className="skill-upload-field">
                    <label className="skill-upload-label">技能文件 <span className="required">*</span></label>
                    <div className="skill-upload-file-row">
                        <input
                            ref={inputRef}
                            type="file"
                            accept=".zip"
                            onChange={handleFileChange}
                            style={{ display: 'none' }}
                        />
                        <button
                            type="button"
                            className="skill-upload-file-btn"
                            onClick={() => inputRef.current?.click()}
                        >
                            {file ? file.name : '＋ 上传技能'}
                        </button>
                        <span className="skill-upload-tip">.zip格式，且解压后必须包含 SKILL.md</span>
                    </div>
                </div>

                {error && <p className="skill-upload-error">{error}</p>}

                <footer>
                    <button type="button" className="skill-btn-cancel" onClick={onClose}>取消</button>
                    <button
                        type="button"
                        className="skill-btn-confirm"
                        disabled={!file || uploading}
                        onClick={handleUpload}
                    >
                        {uploading ? '上传中…' : '确定'}
                    </button>
                </footer>
            </div>
        </div>
    );
}
