/**
 * Phase 27c S5: the board's time-of-day lighting as a filter on the layers upstream lights.
 *
 * Every pixel of the filtered layer is shifted, per channel and clamped, by `(L - 128) * 2 + offset`, where L
 * is the world lightmap (`lighting.ts`'s `worldLightmap`) at that pixel's place on the map: `light_surface`
 * over the hex's terrain images, or, with a neutral lightmap and an offset, `adjust_surface_color` for the
 * images upstream draws `TOD_COLORED` (village flags, the grid, fog and shroud). The shift is applied to the
 * layer's straight colour, as upstream shifts each image's pixels before blending.
 */
import * as PIXI from 'pixi.js'

const vertex = `in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vScreen;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  vScreen = position;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}`

const fragment = `in vec2 vTextureCoord;
in vec2 vScreen;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uLight;
uniform mat3 uWorldFromScreen;
uniform vec4 uLightRect;
uniform vec3 uOffset;

void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  if (c.a <= 0.0) {
    finalColor = c;
    return;
  }
  vec2 world = (uWorldFromScreen * vec3(vScreen, 1.0)).xy;
  vec3 l = texture(uLight, clamp((world - uLightRect.xy) / uLightRect.zw, 0.0, 1.0)).rgb;
  vec3 shift = (floor(l * 255.0 + 0.5) - 128.0) * 2.0 + uOffset;
  vec3 rgb = floor(c.rgb / c.a * 255.0 + 0.5);
  rgb = clamp(rgb + shift, 0.0, 255.0) / 255.0;
  finalColor = vec4(rgb * c.a, c.a);
}`

/** A world lightmap as a texture: straight RGBA, read pixel for pixel. */
export function lightmapTexture(data: Uint8ClampedArray, width: number, height: number): PIXI.Texture {
  const source = new PIXI.BufferImageSource({
    resource: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width,
    height,
    format: 'rgba8unorm',
    scaleMode: 'nearest',
    alphaMode: 'no-premultiply-alpha',
  })
  return new PIXI.Texture({ source })
}

let neutral: PIXI.Texture | null = null

/** A 1x1 lightmap that shifts nothing (for a filter that only adds its offset). */
export function neutralLightmap(): PIXI.Texture {
  neutral ??= lightmapTexture(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1)
  return neutral
}

export class LightingFilter extends PIXI.Filter {
  /**
   * `target`: the layer the filter is on (its world transform maps the screen to the map); `light`: the
   * world lightmap, covering `rect` of the map (world pixels); `offset`: added to every channel's shift.
   */
  constructor(
    private readonly target: PIXI.Container,
    light: PIXI.Texture,
    rect: PIXI.Rectangle,
    offset: readonly [number, number, number],
  ) {
    super({
      glProgram: PIXI.GlProgram.from({ vertex, fragment, name: 'tod-lighting' }),
      resources: {
        lightUniforms: new PIXI.UniformGroup({
          uWorldFromScreen: { value: new PIXI.Matrix(), type: 'mat3x3<f32>' },
          uLightRect: { value: new Float32Array([rect.x, rect.y, rect.width, rect.height]), type: 'vec4<f32>' },
          uOffset: { value: new Float32Array(offset), type: 'vec3<f32>' },
        }),
        uLight: light.source,
      },
    })
  }

  override apply(filterManager: PIXI.FilterSystem, input: PIXI.Texture, output: PIXI.RenderSurface, clearMode: boolean): void {
    const uniforms = (this.resources.lightUniforms as PIXI.UniformGroup).uniforms as { uWorldFromScreen: PIXI.Matrix }
    uniforms.uWorldFromScreen.copyFrom(this.target.worldTransform).invert()
    filterManager.applyFilter(this, input, output, clearMode)
  }
}
