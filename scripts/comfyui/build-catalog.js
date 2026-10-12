#!/usr/bin/env node
// Regenerates electron/lib/comfyui/catalog.json from live Hugging Face metadata.
//
//   node scripts/comfyui/build-catalog.js
//
// Every file listed in SPECS is looked up in its Hugging Face repository. The script
// records the real byte size and the LFS SHA-256 reported by HF, and fails if a file is
// missing. Entries whose status is not "installable" are kept as honest discovery
// records (no download is offered for them).

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'electron', 'lib', 'comfyui', 'catalog.json');

// status:
//   installable      – ComfyUI-native files exist in the listed repo and are downloadable
//   gated            – files exist but the repo requires accepting a license on Hugging Face
//   custom-nodes     – weights exist but need a non-core custom node to load
//   needs-workflow   – weights exist, no verified ComfyUI workflow yet (discovery only)
const SPECS = [
    {
        id: 'sd15', family: 'Stable Diffusion 1.5', kind: 'image', tasks: ['text-to-image'], status: 'installable', license: 'creativeml-openrail-m',
        files: [
            { repo: 'stable-diffusion-v1-5/stable-diffusion-v1-5', path: 'v1-5-pruned-emaonly.safetensors', folder: 'checkpoints', role: 'checkpoint' },
        ],
    },
    {
        id: 'sdxl-base', family: 'SDXL 1.0', kind: 'image', tasks: ['text-to-image', 'image-to-image'], status: 'installable', license: 'openrail++',
        files: [
            { repo: 'stabilityai/stable-diffusion-xl-base-1.0', path: 'sd_xl_base_1.0.safetensors', folder: 'checkpoints', role: 'checkpoint' },
        ],
    },
    {
        id: 'sd35-large', family: 'Stable Diffusion 3.5 Large', kind: 'image', tasks: ['text-to-image'], status: 'installable', license: 'other (Stability Community License)',
        files: [
            { repo: 'Comfy-Org/stable-diffusion-3.5-fp8', path: 'sd3.5_large_fp8_scaled.safetensors', folder: 'checkpoints', role: 'checkpoint' },
        ],
    },
    {
        id: 'flux1-dev', family: 'FLUX.1 [dev]', kind: 'image', tasks: ['text-to-image'], status: 'installable', license: 'other (FLUX.1 [dev] non-commercial)',
        files: [
            { repo: 'Comfy-Org/flux1-dev', path: 'flux1-dev-fp8.safetensors', folder: 'checkpoints', role: 'checkpoint' },
        ],
    },
    {
        id: 'z-image-turbo', family: 'Z-Image Turbo', kind: 'image', tasks: ['text-to-image'], status: 'installable', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/z_image_turbo', path: 'split_files/diffusion_models/z_image_turbo_bf16.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
            { repo: 'Comfy-Org/z_image_turbo', path: 'split_files/text_encoders/qwen_3_4b.safetensors', folder: 'text_encoders', role: 'text-encoder' },
            { repo: 'Comfy-Org/z_image_turbo', path: 'split_files/vae/ae.safetensors', folder: 'vae', role: 'vae' },
        ],
    },
    {
        id: 'qwen-image', family: 'Qwen-Image', kind: 'image', tasks: ['text-to-image'], status: 'installable', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/Qwen-Image_ComfyUI', path: 'split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
            { repo: 'Comfy-Org/Qwen-Image_ComfyUI', path: 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', folder: 'text_encoders', role: 'text-encoder' },
            { repo: 'Comfy-Org/Qwen-Image_ComfyUI', path: 'split_files/vae/qwen_image_vae.safetensors', folder: 'vae', role: 'vae' },
        ],
    },
    {
        id: 'qwen-image-edit', family: 'Qwen-Image-Edit (2509)', kind: 'image', tasks: ['image-editing'], status: 'needs-workflow', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/Qwen-Image-Edit_ComfyUI', path: 'split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
        ],
        companions: 'Needs the Qwen-Image text encoder and VAE, and no verified edit workflow is bundled yet.',
    },
    {
        id: 'flux2-dev', family: 'FLUX.2 [dev]', kind: 'image', tasks: ['text-to-image', 'image-editing'], status: 'installable', license: 'other (FLUX.2 [dev] non-commercial)',
        files: [
            { repo: 'Comfy-Org/flux2-dev', path: 'split_files/diffusion_models/flux2_dev_fp8mixed.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
            { repo: 'Comfy-Org/flux2-dev', path: 'split_files/text_encoders/mistral_3_small_flux2_fp8.safetensors', folder: 'text_encoders', role: 'text-encoder' },
            { repo: 'Comfy-Org/flux2-dev', path: 'split_files/vae/flux2-vae.safetensors', folder: 'vae', role: 'vae' },
        ],
    },
    {
        id: 'chroma1-hd', family: 'Chroma1-HD', kind: 'image', tasks: ['text-to-image'], status: 'needs-workflow', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/Chroma1-HD_repackaged', path: 'split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
        ],
        companions: 'UNET-only file. Chroma also needs the T5-XXL text encoder and a FLUX VAE.',
    },
    {
        id: 'wan22-ti2v-5b', family: 'Wan 2.2 TI2V 5B', kind: 'video', tasks: ['text-to-video', 'image-to-video'], status: 'needs-workflow', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', path: 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
            { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', path: 'split_files/text_encoders/umt5_xxl_fp16.safetensors', folder: 'text_encoders', role: 'text-encoder' },
        ],
        companions: 'Wan 2.2 workflows also need the Wan 2.2 VAE, which is not yet in this entry.',
    },
    {
        id: 'wan22-t2v-14b', family: 'Wan 2.2 T2V 14B', kind: 'video', tasks: ['text-to-video'], status: 'needs-workflow', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', path: 'split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors', folder: 'diffusion_models', role: 'diffusion-model (high noise)' },
            { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', path: 'split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors', folder: 'diffusion_models', role: 'diffusion-model (low noise)' },
            { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', path: 'split_files/text_encoders/umt5_xxl_fp16.safetensors', folder: 'text_encoders', role: 'text-encoder' },
        ],
        companions: 'Wan 2.2 workflows also need the Wan 2.2 VAE, which is not yet in this entry.',
    },
    {
        id: 'wan21-i2v-14b', family: 'Wan 2.1 I2V 14B', kind: 'video', tasks: ['image-to-video'], status: 'needs-workflow', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', path: 'split_files/diffusion_models/wan2.1_i2v_480p_14B_fp8_e4m3fn.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
            { repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', path: 'split_files/clip_vision/clip_vision_h.safetensors', folder: 'clip_vision', role: 'clip-vision' },
        ],
        companions: 'Wan 2.1 workflows also need the Wan 2.1 VAE, which is not yet in this entry.',
    },
    {
        id: 'hunyuanvideo15-t2v', family: 'HunyuanVideo 1.5 T2V 480p', kind: 'video', tasks: ['text-to-video'], status: 'needs-workflow', license: 'other (Tencent Hunyuan Community License)',
        files: [
            { repo: 'Comfy-Org/HunyuanVideo_1.5_repackaged', path: 'split_files/diffusion_models/hunyuanvideo1.5_480p_t2v_fp16.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
        ],
        companions: 'Needs the HunyuanVideo 1.5 text encoders and VAE, which are not yet in this entry.',
    },
    {
        id: 'mochi1', family: 'Mochi 1 (preview)', kind: 'video', tasks: ['text-to-video'], status: 'installable', license: 'apache-2.0',
        files: [
            { repo: 'Comfy-Org/mochi_preview_repackaged', path: 'split_files/diffusion_models/mochi_preview_fp8_scaled.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
            { repo: 'Comfy-Org/mochi_preview_repackaged', path: 'split_files/text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors', folder: 'text_encoders', role: 'text-encoder' },
            { repo: 'Comfy-Org/mochi_preview_repackaged', path: 'split_files/vae/mochi_vae.safetensors', folder: 'vae', role: 'vae' },
        ],
    },
    {
        id: 'ltx2', family: 'LTX-2', kind: 'video', tasks: ['text-to-video', 'image-to-video'], status: 'needs-workflow', license: 'other (LTX-2 community license)',
        files: [
            { repo: 'Comfy-Org/ltx-2', path: 'split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors', folder: 'text_encoders', role: 'text-encoder' },
        ],
        companions: 'This file is only the Gemma text encoder. The LTX-2 checkpoint itself is not in this entry.',
    },
    {
        id: 'ltx23', family: 'LTX-2.3', kind: 'video', tasks: ['text-to-video', 'image-to-video'], status: 'needs-workflow', license: 'other (Lightricks)',
        files: [
            { repo: 'Lightricks/LTX-2.3', path: 'ltx-2.3-22b-distilled.safetensors', folder: 'checkpoints', role: 'checkpoint' },
        ],
        companions: 'Weights are published, but no ComfyUI-native workflow has been verified in this catalog yet.',
    },
    {
        id: 'ltx25', family: 'LTX-2.5', kind: 'video', tasks: ['text-to-video', 'image-to-video'], status: 'gated', license: 'other (Lightricks)',
        files: [
            { repo: 'Lightricks/LTX-2.5', path: 'diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
        ],
        companions: 'Hugging Face requires you to accept the license on the model page before downloading.',
    },
    {
        id: 'minimax-h3', family: 'MiniMax H3', kind: 'video', tasks: ['image-to-video', 'reference-to-video'], status: 'needs-workflow', license: 'other (MiniMax)',
        files: [
            { repo: 'Comfy-Org/MiniMax-H3', path: 'diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors', folder: 'diffusion_models', role: 'diffusion-model' },
        ],
        companions: 'Weights are published by Comfy-Org. A verified ComfyUI workflow and its companion files are still needed.',
    },
    {
        id: 'cogvideox-5b', family: 'CogVideoX-5B', kind: 'video', tasks: ['text-to-video', 'image-to-video'], status: 'custom-nodes', license: 'other (CogVideoX)',
        files: [],
        companions: 'Published as a diffusers folder layout, not a single ComfyUI file. It needs a custom node pack, so it is listed for discovery only.',
    },
];

async function hfTree(repo) {
    const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { headers: { 'User-Agent': 'mincomfy-ui-catalog' } });
    if (!res.ok) throw new Error(`HF tree ${repo}: HTTP ${res.status}`);
    return res.json();
}

async function main() {
    const repoCache = new Map();
    const out = { generatedAt: new Date().toISOString(), source: 'huggingface.co (tree API: size and LFS sha256)', entries: [] };
    for (const spec of SPECS) {
        const files = [];
        for (const f of spec.files) {
            if (!repoCache.has(f.repo)) repoCache.set(f.repo, await hfTree(f.repo));
            const entry = repoCache.get(f.repo).find((x) => x.type === 'file' && x.path === f.path);
            if (!entry) throw new Error(`${spec.id}: ${f.repo}/${f.path} not found`);
            const sha256 = entry.lfs?.oid;
            // Gated repos hide LFS hashes from the tree API. Those entries are never downloaded
            // (status "gated"), so a null hash is acceptable there and nowhere else.
            if (spec.status !== 'gated' && (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))) throw new Error(`${spec.id}: missing sha256 for ${f.path}`);

            files.push({
                ...f,
                filename: path.basename(f.path),
                url: `https://huggingface.co/${f.repo}/resolve/main/${f.path}`,
                sizeBytes: entry.size,
                sha256: /^[0-9a-f]{64}$/.test(sha256 || '') ? sha256 : null, // gated: HF hides the hash ('*****')
            });
        }
        out.entries.push({ ...spec, files, verifiedAt: out.generatedAt });
        console.log(`✓ ${spec.id} (${files.length} files, ${(files.reduce((a, f) => a + f.sizeBytes, 0) / 1e9).toFixed(2)} GB)`);
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { SPECS };
