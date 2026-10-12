// Shared constants for the MinComfy UI ComfyUI integration.
// Node class names and input names were verified against ComfyUI 0.39.0
// (GET /object_info on a live instance). See tests/fixtures/object_info.subset.json.

// Loader node inputs that reference a model file, and the ComfyUI models/ folder
// the file must live in. Keyed by node class, then input name.
const MODEL_FILE_INPUTS = {
    CheckpointLoaderSimple: { ckpt_name: 'checkpoints' },
    CheckpointLoader: { ckpt_name: 'checkpoints' },
    ImageOnlyCheckpointLoader: { ckpt_name: 'checkpoints' },
    unCLIPCheckpointLoader: { ckpt_name: 'checkpoints' },
    UNETLoader: { unet_name: 'diffusion_models' },
    CLIPLoader: { clip_name: 'text_encoders' },
    DualCLIPLoader: { clip_name1: 'text_encoders', clip_name2: 'text_encoders' },
    TripleCLIPLoader: { clip_name1: 'text_encoders', clip_name2: 'text_encoders', clip_name3: 'text_encoders' },
    CLIPVisionLoader: { clip_name: 'clip_vision' },
    VAELoader: { vae_name: 'vae' },
    LoraLoader: { lora_name: 'loras' },
    LoraLoaderModelOnly: { lora_name: 'loras' },
    ControlNetLoader: { control_net_name: 'controlnet' },
    UpscaleModelLoader: { model_name: 'upscale_models' },
    StyleModelLoader: { style_model_name: 'style_models' },
};

// Output nodes that persist media. The value is the media type we return to the UI.
const OUTPUT_NODE_TYPES = {
    SaveImage: 'image',
    SaveAnimatedWEBP: 'image',
    SaveAnimatedPNG: 'image',
    PreviewImage: 'image',
    SaveVideo: 'video',
    SaveWEBM: 'video',
    VHS_VideoCombine: 'video',
};

// Node classes that exist only in the frontend graph and never reach /prompt.
const UI_ONLY_NODE_TYPES = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode']);

// Sampler classes we know how to expose as a simplified form.
const SAMPLER_CLASSES = {
    KSampler: { seed: 'seed', steps: 'steps', cfg: 'cfg', sampler_name: 'sampler_name', scheduler: 'scheduler', denoise: 'denoise', positive: 'positive', negative: 'negative', latent: 'latent_image' },
    KSamplerAdvanced: { seed: 'noise_seed', steps: 'steps', cfg: 'cfg', sampler_name: 'sampler_name', scheduler: 'scheduler', denoise: null, positive: 'positive', negative: 'negative', latent: 'latent_image' },
};

// Latent/empty-canvas nodes whose width/height/length we expose as sizing controls.
const LATENT_SIZE_CLASSES = new Set([
    'EmptyLatentImage',
    'EmptySD3LatentImage',
    'EmptyHunyuanLatentVideo',
    'EmptyLTXVLatentVideo',
    'EmptyMochiLatentVideo',
    'EmptyHunyuanImageLatent',
    'EmptyFlux2LatentImage',
]);

// Input types that ComfyUI serialises into widgets_values.
const PRIMITIVE_WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN']);

// Pure-link inputs (no widget) for ComfyUI types — used when laying out UI graphs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
    MODEL_FILE_INPUTS,
    OUTPUT_NODE_TYPES,
    UI_ONLY_NODE_TYPES,
    SAMPLER_CLASSES,
    LATENT_SIZE_CLASSES,
    PRIMITIVE_WIDGET_TYPES,
    UUID_RE,
};
