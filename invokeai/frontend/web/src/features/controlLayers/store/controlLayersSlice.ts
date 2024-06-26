import type { PayloadAction, UnknownAction } from '@reduxjs/toolkit';
import { createSlice, isAnyOf } from '@reduxjs/toolkit';
import type { PersistConfig, RootState } from 'app/store/store';
import { moveBackward, moveForward, moveToBack, moveToFront } from 'common/util/arrayUtils';
import { deepClone } from 'common/util/deepClone';
import { roundToMultiple } from 'common/util/roundDownToMultiple';
import {
  controlAdapterImageChanged,
  controlAdapterProcessedImageChanged,
  isAnyControlAdapterAdded,
} from 'features/controlAdapters/store/controlAdaptersSlice';
import { calculateNewSize } from 'features/parameters/components/ImageSize/calculateNewSize';
import { initialAspectRatioState } from 'features/parameters/components/ImageSize/constants';
import type { AspectRatioState } from 'features/parameters/components/ImageSize/types';
import { modelChanged } from 'features/parameters/store/generationSlice';
import type { ParameterAutoNegative } from 'features/parameters/types/parameterSchemas';
import { getIsSizeOptimal, getOptimalDimension } from 'features/parameters/util/optimalDimension';
import type { IRect, Vector2d } from 'konva/lib/types';
import { isEqual, partition } from 'lodash-es';
import { atom } from 'nanostores';
import type { RgbColor } from 'react-colorful';
import type { UndoableOptions } from 'redux-undo';
import { assert } from 'tsafe';
import { v4 as uuidv4 } from 'uuid';

import type {
  ControlAdapterLayer,
  ControlLayersState,
  DrawingTool,
  IPAdapterLayer,
  Layer,
  RegionalGuidanceLayer,
  Tool,
  VectorMaskLine,
  VectorMaskRect,
} from './types';

export const initialControlLayersState: ControlLayersState = {
  _version: 1,
  selectedLayerId: null,
  brushSize: 100,
  layers: [],
  globalMaskLayerOpacity: 0.3, // this globally changes all mask layers' opacity
  isEnabled: true,
  positivePrompt: '',
  negativePrompt: '',
  positivePrompt2: '',
  negativePrompt2: '',
  shouldConcatPrompts: true,
  initialImage: null,
  size: {
    width: 512,
    height: 512,
    aspectRatio: deepClone(initialAspectRatioState),
  },
};

const isLine = (obj: VectorMaskLine | VectorMaskRect): obj is VectorMaskLine => obj.type === 'vector_mask_line';
export const isRegionalGuidanceLayer = (layer?: Layer): layer is RegionalGuidanceLayer =>
  layer?.type === 'regional_guidance_layer';
export const isControlAdapterLayer = (layer?: Layer): layer is ControlAdapterLayer =>
  layer?.type === 'control_adapter_layer';
export const isIPAdapterLayer = (layer?: Layer): layer is IPAdapterLayer => layer?.type === 'ip_adapter_layer';
export const isRenderableLayer = (layer?: Layer): layer is RegionalGuidanceLayer | ControlAdapterLayer =>
  layer?.type === 'regional_guidance_layer' || layer?.type === 'control_adapter_layer';
const resetLayer = (layer: Layer) => {
  if (layer.type === 'regional_guidance_layer') {
    layer.maskObjects = [];
    layer.bbox = null;
    layer.isEnabled = true;
    layer.needsPixelBbox = false;
    layer.bboxNeedsUpdate = false;
    return;
  }

  if (layer.type === 'control_adapter_layer') {
    // TODO
  }
};
const getVectorMaskPreviewColor = (state: ControlLayersState): RgbColor => {
  const vmLayers = state.layers.filter(isRegionalGuidanceLayer);
  const lastColor = vmLayers[vmLayers.length - 1]?.previewColor;
  return LayerColors.next(lastColor);
};

export const controlLayersSlice = createSlice({
  name: 'controlLayers',
  initialState: initialControlLayersState,
  reducers: {
    //#region All Layers
    regionalGuidanceLayerAdded: (state, action: PayloadAction<{ layerId: string }>) => {
      const { layerId } = action.payload;
      const layer: RegionalGuidanceLayer = {
        id: getRegionalGuidanceLayerId(layerId),
        type: 'regional_guidance_layer',
        isEnabled: true,
        bbox: null,
        bboxNeedsUpdate: false,
        maskObjects: [],
        previewColor: getVectorMaskPreviewColor(state),
        x: 0,
        y: 0,
        autoNegative: 'invert',
        needsPixelBbox: false,
        positivePrompt: '',
        negativePrompt: null,
        ipAdapterIds: [],
        isSelected: true,
      };
      state.layers.push(layer);
      state.selectedLayerId = layer.id;
      for (const layer of state.layers.filter(isRenderableLayer)) {
        if (layer.id !== layerId) {
          layer.isSelected = false;
        }
      }
      return;
    },
    ipAdapterLayerAdded: (state, action: PayloadAction<{ layerId: string; ipAdapterId: string }>) => {
      const { layerId, ipAdapterId } = action.payload;
      const layer: IPAdapterLayer = {
        id: getIPAdapterLayerId(layerId),
        type: 'ip_adapter_layer',
        isEnabled: true,
        ipAdapterId,
      };
      state.layers.push(layer);
      return;
    },
    controlAdapterLayerAdded: (state, action: PayloadAction<{ layerId: string; controlNetId: string }>) => {
      const { layerId, controlNetId } = action.payload;
      const layer: ControlAdapterLayer = {
        id: getControlNetLayerId(layerId),
        type: 'control_adapter_layer',
        controlNetId,
        x: 0,
        y: 0,
        bbox: null,
        bboxNeedsUpdate: false,
        isEnabled: true,
        imageName: null,
        opacity: 1,
        isSelected: true,
        isFilterEnabled: true,
      };
      state.layers.push(layer);
      state.selectedLayerId = layer.id;
      for (const layer of state.layers.filter(isRenderableLayer)) {
        if (layer.id !== layerId) {
          layer.isSelected = false;
        }
      }
      return;
    },
    layerSelected: (state, action: PayloadAction<string>) => {
      for (const layer of state.layers.filter(isRenderableLayer)) {
        if (layer.id === action.payload) {
          layer.isSelected = true;
          state.selectedLayerId = action.payload;
        } else {
          layer.isSelected = false;
        }
      }
    },
    layerVisibilityToggled: (state, action: PayloadAction<string>) => {
      const layer = state.layers.find((l) => l.id === action.payload);
      if (layer) {
        layer.isEnabled = !layer.isEnabled;
      }
    },
    layerTranslated: (state, action: PayloadAction<{ layerId: string; x: number; y: number }>) => {
      const { layerId, x, y } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (isRenderableLayer(layer)) {
        layer.x = x;
        layer.y = y;
      }
    },
    layerBboxChanged: (state, action: PayloadAction<{ layerId: string; bbox: IRect | null }>) => {
      const { layerId, bbox } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (isRenderableLayer(layer)) {
        layer.bbox = bbox;
        layer.bboxNeedsUpdate = false;
        if (bbox === null && layer.type === 'regional_guidance_layer') {
          // The layer was fully erased, empty its objects to prevent accumulation of invisible objects
          layer.maskObjects = [];
          layer.needsPixelBbox = false;
        }
      }
    },
    layerReset: (state, action: PayloadAction<string>) => {
      const layer = state.layers.find((l) => l.id === action.payload);
      if (layer) {
        resetLayer(layer);
      }
    },
    layerDeleted: (state, action: PayloadAction<string>) => {
      state.layers = state.layers.filter((l) => l.id !== action.payload);
      state.selectedLayerId = state.layers[0]?.id ?? null;
    },
    layerMovedForward: (state, action: PayloadAction<string>) => {
      const cb = (l: Layer) => l.id === action.payload;
      const [renderableLayers, ipAdapterLayers] = partition(state.layers, isRenderableLayer);
      moveForward(renderableLayers, cb);
      state.layers = [...ipAdapterLayers, ...renderableLayers];
    },
    layerMovedToFront: (state, action: PayloadAction<string>) => {
      const cb = (l: Layer) => l.id === action.payload;
      const [renderableLayers, ipAdapterLayers] = partition(state.layers, isRenderableLayer);
      // Because the layers are in reverse order, moving to the front is equivalent to moving to the back
      moveToBack(renderableLayers, cb);
      state.layers = [...ipAdapterLayers, ...renderableLayers];
    },
    layerMovedBackward: (state, action: PayloadAction<string>) => {
      const cb = (l: Layer) => l.id === action.payload;
      const [renderableLayers, ipAdapterLayers] = partition(state.layers, isRenderableLayer);
      moveBackward(renderableLayers, cb);
      state.layers = [...ipAdapterLayers, ...renderableLayers];
    },
    layerMovedToBack: (state, action: PayloadAction<string>) => {
      const cb = (l: Layer) => l.id === action.payload;
      const [renderableLayers, ipAdapterLayers] = partition(state.layers, isRenderableLayer);
      // Because the layers are in reverse order, moving to the back is equivalent to moving to the front
      moveToFront(renderableLayers, cb);
      state.layers = [...ipAdapterLayers, ...renderableLayers];
    },
    selectedLayerReset: (state) => {
      const layer = state.layers.find((l) => l.id === state.selectedLayerId);
      if (layer) {
        resetLayer(layer);
      }
    },
    selectedLayerDeleted: (state) => {
      state.layers = state.layers.filter((l) => l.id !== state.selectedLayerId);
      state.selectedLayerId = state.layers[0]?.id ?? null;
    },
    layerOpacityChanged: (state, action: PayloadAction<{ layerId: string; opacity: number }>) => {
      const { layerId, opacity } = action.payload;
      const layer = state.layers.filter(isControlAdapterLayer).find((l) => l.id === layerId);
      if (layer) {
        layer.opacity = opacity;
      }
    },
    //#endregion

    //#region CA Layers
    isFilterEnabledChanged: (state, action: PayloadAction<{ layerId: string; isFilterEnabled: boolean }>) => {
      const { layerId, isFilterEnabled } = action.payload;
      const layer = state.layers.filter(isControlAdapterLayer).find((l) => l.id === layerId);
      if (layer) {
        layer.isFilterEnabled = isFilterEnabled;
      }
    },
    //#endregion

    //#region Mask Layers
    maskLayerPositivePromptChanged: (state, action: PayloadAction<{ layerId: string; prompt: string | null }>) => {
      const { layerId, prompt } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (layer?.type === 'regional_guidance_layer') {
        layer.positivePrompt = prompt;
      }
    },
    maskLayerNegativePromptChanged: (state, action: PayloadAction<{ layerId: string; prompt: string | null }>) => {
      const { layerId, prompt } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (layer?.type === 'regional_guidance_layer') {
        layer.negativePrompt = prompt;
      }
    },
    maskLayerIPAdapterAdded: (state, action: PayloadAction<{ layerId: string; ipAdapterId: string }>) => {
      const { layerId, ipAdapterId } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (layer?.type === 'regional_guidance_layer') {
        layer.ipAdapterIds.push(ipAdapterId);
      }
    },
    maskLayerIPAdapterDeleted: (state, action: PayloadAction<{ layerId: string; ipAdapterId: string }>) => {
      const { layerId, ipAdapterId } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (layer?.type === 'regional_guidance_layer') {
        layer.ipAdapterIds = layer.ipAdapterIds.filter((id) => id !== ipAdapterId);
      }
    },
    maskLayerPreviewColorChanged: (state, action: PayloadAction<{ layerId: string; color: RgbColor }>) => {
      const { layerId, color } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (layer?.type === 'regional_guidance_layer') {
        layer.previewColor = color;
      }
    },
    maskLayerLineAdded: {
      reducer: (
        state,
        action: PayloadAction<
          { layerId: string; points: [number, number, number, number]; tool: DrawingTool },
          string,
          { uuid: string }
        >
      ) => {
        const { layerId, points, tool } = action.payload;
        const layer = state.layers.find((l) => l.id === layerId);
        if (layer?.type === 'regional_guidance_layer') {
          const lineId = getRegionalGuidanceLayerLineId(layer.id, action.meta.uuid);
          layer.maskObjects.push({
            type: 'vector_mask_line',
            tool: tool,
            id: lineId,
            // Points must be offset by the layer's x and y coordinates
            // TODO: Handle this in the event listener?
            points: [points[0] - layer.x, points[1] - layer.y, points[2] - layer.x, points[3] - layer.y],
            strokeWidth: state.brushSize,
          });
          layer.bboxNeedsUpdate = true;
          if (!layer.needsPixelBbox && tool === 'eraser') {
            layer.needsPixelBbox = true;
          }
        }
      },
      prepare: (payload: { layerId: string; points: [number, number, number, number]; tool: DrawingTool }) => ({
        payload,
        meta: { uuid: uuidv4() },
      }),
    },
    maskLayerPointsAdded: (state, action: PayloadAction<{ layerId: string; point: [number, number] }>) => {
      const { layerId, point } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (layer?.type === 'regional_guidance_layer') {
        const lastLine = layer.maskObjects.findLast(isLine);
        if (!lastLine) {
          return;
        }
        // Points must be offset by the layer's x and y coordinates
        // TODO: Handle this in the event listener
        lastLine.points.push(point[0] - layer.x, point[1] - layer.y);
        layer.bboxNeedsUpdate = true;
      }
    },
    maskLayerRectAdded: {
      reducer: (state, action: PayloadAction<{ layerId: string; rect: IRect }, string, { uuid: string }>) => {
        const { layerId, rect } = action.payload;
        if (rect.height === 0 || rect.width === 0) {
          // Ignore zero-area rectangles
          return;
        }
        const layer = state.layers.find((l) => l.id === layerId);
        if (layer?.type === 'regional_guidance_layer') {
          const id = getMaskedGuidnaceLayerRectId(layer.id, action.meta.uuid);
          layer.maskObjects.push({
            type: 'vector_mask_rect',
            id,
            x: rect.x - layer.x,
            y: rect.y - layer.y,
            width: rect.width,
            height: rect.height,
          });
          layer.bboxNeedsUpdate = true;
        }
      },
      prepare: (payload: { layerId: string; rect: IRect }) => ({ payload, meta: { uuid: uuidv4() } }),
    },
    maskLayerAutoNegativeChanged: (
      state,
      action: PayloadAction<{ layerId: string; autoNegative: ParameterAutoNegative }>
    ) => {
      const { layerId, autoNegative } = action.payload;
      const layer = state.layers.find((l) => l.id === layerId);
      if (layer?.type === 'regional_guidance_layer') {
        layer.autoNegative = autoNegative;
      }
    },
    //#endregion

    //#region Base Layer
    positivePromptChanged: (state, action: PayloadAction<string>) => {
      state.positivePrompt = action.payload;
    },
    negativePromptChanged: (state, action: PayloadAction<string>) => {
      state.negativePrompt = action.payload;
    },
    positivePrompt2Changed: (state, action: PayloadAction<string>) => {
      state.positivePrompt2 = action.payload;
    },
    negativePrompt2Changed: (state, action: PayloadAction<string>) => {
      state.negativePrompt2 = action.payload;
    },
    shouldConcatPromptsChanged: (state, action: PayloadAction<boolean>) => {
      state.shouldConcatPrompts = action.payload;
    },
    widthChanged: (state, action: PayloadAction<{ width: number; updateAspectRatio?: boolean }>) => {
      const { width, updateAspectRatio } = action.payload;
      state.size.width = width;
      if (updateAspectRatio) {
        state.size.aspectRatio.value = width / state.size.height;
        state.size.aspectRatio.id = 'Free';
        state.size.aspectRatio.isLocked = false;
      }
    },
    heightChanged: (state, action: PayloadAction<{ height: number; updateAspectRatio?: boolean }>) => {
      const { height, updateAspectRatio } = action.payload;
      state.size.height = height;
      if (updateAspectRatio) {
        state.size.aspectRatio.value = state.size.width / height;
        state.size.aspectRatio.id = 'Free';
        state.size.aspectRatio.isLocked = false;
      }
    },
    aspectRatioChanged: (state, action: PayloadAction<AspectRatioState>) => {
      state.size.aspectRatio = action.payload;
    },
    //#endregion

    //#region General
    brushSizeChanged: (state, action: PayloadAction<number>) => {
      state.brushSize = Math.round(action.payload);
    },
    globalMaskLayerOpacityChanged: (state, action: PayloadAction<number>) => {
      state.globalMaskLayerOpacity = action.payload;
    },
    isEnabledChanged: (state, action: PayloadAction<boolean>) => {
      state.isEnabled = action.payload;
    },
    undo: (state) => {
      // Invalidate the bbox for all layers to prevent stale bboxes
      for (const layer of state.layers.filter(isRenderableLayer)) {
        layer.bboxNeedsUpdate = true;
      }
    },
    redo: (state) => {
      // Invalidate the bbox for all layers to prevent stale bboxes
      for (const layer of state.layers.filter(isRenderableLayer)) {
        layer.bboxNeedsUpdate = true;
      }
    },
    //#endregion
  },
  extraReducers(builder) {
    builder.addCase(modelChanged, (state, action) => {
      const newModel = action.payload;
      if (!newModel || action.meta.previousModel?.base === newModel.base) {
        // Model was cleared or the base didn't change
        return;
      }
      const optimalDimension = getOptimalDimension(newModel);
      if (getIsSizeOptimal(state.size.width, state.size.height, optimalDimension)) {
        return;
      }
      const { width, height } = calculateNewSize(state.size.aspectRatio.value, optimalDimension * optimalDimension);
      state.size.width = width;
      state.size.height = height;
    });

    builder.addCase(controlAdapterImageChanged, (state, action) => {
      const { id, controlImage } = action.payload;
      const layer = state.layers.filter(isControlAdapterLayer).find((l) => l.controlNetId === id);
      if (layer) {
        layer.bbox = null;
        layer.bboxNeedsUpdate = true;
        layer.isEnabled = true;
        layer.imageName = controlImage?.image_name ?? null;
      }
    });

    builder.addCase(controlAdapterProcessedImageChanged, (state, action) => {
      const { id, processedControlImage } = action.payload;
      const layer = state.layers.filter(isControlAdapterLayer).find((l) => l.controlNetId === id);
      if (layer) {
        layer.bbox = null;
        layer.bboxNeedsUpdate = true;
        layer.isEnabled = true;
        layer.imageName = processedControlImage?.image_name ?? null;
      }
    });

    // TODO: This is a temp fix to reduce issues with T2I adapter having a different downscaling
    // factor than the UNet. Hopefully we get an upstream fix in diffusers.
    builder.addMatcher(isAnyControlAdapterAdded, (state, action) => {
      if (action.payload.type === 't2i_adapter') {
        state.size.width = roundToMultiple(state.size.width, 64);
        state.size.height = roundToMultiple(state.size.height, 64);
      }
    });
  },
});

/**
 * This class is used to cycle through a set of colors for the prompt region layers.
 */
class LayerColors {
  static COLORS: RgbColor[] = [
    { r: 121, g: 157, b: 219 }, // rgb(121, 157, 219)
    { r: 131, g: 214, b: 131 }, // rgb(131, 214, 131)
    { r: 250, g: 225, b: 80 }, // rgb(250, 225, 80)
    { r: 220, g: 144, b: 101 }, // rgb(220, 144, 101)
    { r: 224, g: 117, b: 117 }, // rgb(224, 117, 117)
    { r: 213, g: 139, b: 202 }, // rgb(213, 139, 202)
    { r: 161, g: 120, b: 214 }, // rgb(161, 120, 214)
  ];
  static i = this.COLORS.length - 1;
  /**
   * Get the next color in the sequence. If a known color is provided, the next color will be the one after it.
   */
  static next(currentColor?: RgbColor): RgbColor {
    if (currentColor) {
      const i = this.COLORS.findIndex((c) => isEqual(c, currentColor));
      if (i !== -1) {
        this.i = i;
      }
    }
    this.i = (this.i + 1) % this.COLORS.length;
    const color = this.COLORS[this.i];
    assert(color);
    return color;
  }
}

export const {
  // All layer actions
  layerDeleted,
  layerMovedBackward,
  layerMovedForward,
  layerMovedToBack,
  layerMovedToFront,
  layerReset,
  layerSelected,
  layerTranslated,
  layerBboxChanged,
  layerVisibilityToggled,
  selectedLayerReset,
  selectedLayerDeleted,
  regionalGuidanceLayerAdded,
  ipAdapterLayerAdded,
  controlAdapterLayerAdded,
  layerOpacityChanged,
  // CA layer actions
  isFilterEnabledChanged,
  // Mask layer actions
  maskLayerLineAdded,
  maskLayerPointsAdded,
  maskLayerRectAdded,
  maskLayerNegativePromptChanged,
  maskLayerPositivePromptChanged,
  maskLayerIPAdapterAdded,
  maskLayerIPAdapterDeleted,
  maskLayerAutoNegativeChanged,
  maskLayerPreviewColorChanged,
  // Base layer actions
  positivePromptChanged,
  negativePromptChanged,
  positivePrompt2Changed,
  negativePrompt2Changed,
  shouldConcatPromptsChanged,
  widthChanged,
  heightChanged,
  aspectRatioChanged,
  // General actions
  brushSizeChanged,
  globalMaskLayerOpacityChanged,
  undo,
  redo,
} = controlLayersSlice.actions;

export const selectAllControlAdapterIds = (controlLayers: ControlLayersState) =>
  controlLayers.layers.flatMap((l) => {
    if (l.type === 'control_adapter_layer') {
      return [l.controlNetId];
    }
    if (l.type === 'ip_adapter_layer') {
      return [l.ipAdapterId];
    }
    if (l.type === 'regional_guidance_layer') {
      return l.ipAdapterIds;
    }
    return [];
  });

export const selectControlLayersSlice = (state: RootState) => state.controlLayers;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const migrateControlLayersState = (state: any): any => {
  return state;
};

export const $isMouseDown = atom(false);
export const $isMouseOver = atom(false);
export const $lastMouseDownPos = atom<Vector2d | null>(null);
export const $tool = atom<Tool>('brush');
export const $cursorPosition = atom<Vector2d | null>(null);

// IDs for singleton Konva layers and objects
export const TOOL_PREVIEW_LAYER_ID = 'tool_preview_layer';
export const TOOL_PREVIEW_BRUSH_GROUP_ID = 'tool_preview_layer.brush_group';
export const TOOL_PREVIEW_BRUSH_FILL_ID = 'tool_preview_layer.brush_fill';
export const TOOL_PREVIEW_BRUSH_BORDER_INNER_ID = 'tool_preview_layer.brush_border_inner';
export const TOOL_PREVIEW_BRUSH_BORDER_OUTER_ID = 'tool_preview_layer.brush_border_outer';
export const TOOL_PREVIEW_RECT_ID = 'tool_preview_layer.rect';
export const BACKGROUND_LAYER_ID = 'background_layer';
export const BACKGROUND_RECT_ID = 'background_layer.rect';
export const NO_LAYERS_MESSAGE_LAYER_ID = 'no_layers_message';

// Names (aka classes) for Konva layers and objects
export const CONTROLNET_LAYER_NAME = 'control_adapter_layer';
export const CONTROLNET_LAYER_IMAGE_NAME = 'control_adapter_layer.image';
export const regional_guidance_layer_NAME = 'regional_guidance_layer';
export const regional_guidance_layer_LINE_NAME = 'regional_guidance_layer.line';
export const regional_guidance_layer_OBJECT_GROUP_NAME = 'regional_guidance_layer.object_group';
export const regional_guidance_layer_RECT_NAME = 'regional_guidance_layer.rect';
export const LAYER_BBOX_NAME = 'layer.bbox';

// Getters for non-singleton layer and object IDs
const getRegionalGuidanceLayerId = (layerId: string) => `${regional_guidance_layer_NAME}_${layerId}`;
const getRegionalGuidanceLayerLineId = (layerId: string, lineId: string) => `${layerId}.line_${lineId}`;
const getMaskedGuidnaceLayerRectId = (layerId: string, lineId: string) => `${layerId}.rect_${lineId}`;
export const getRegionalGuidanceLayerObjectGroupId = (layerId: string, groupId: string) =>
  `${layerId}.objectGroup_${groupId}`;
export const getLayerBboxId = (layerId: string) => `${layerId}.bbox`;
const getControlNetLayerId = (layerId: string) => `control_adapter_layer_${layerId}`;
export const getControlNetLayerImageId = (layerId: string, imageName: string) => `${layerId}.image_${imageName}`;
const getIPAdapterLayerId = (layerId: string) => `ip_adapter_layer_${layerId}`;

export const controlLayersPersistConfig: PersistConfig<ControlLayersState> = {
  name: controlLayersSlice.name,
  initialState: initialControlLayersState,
  migrate: migrateControlLayersState,
  persistDenylist: [],
};

// These actions are _individually_ grouped together as single undoable actions
const undoableGroupByMatcher = isAnyOf(
  layerTranslated,
  brushSizeChanged,
  globalMaskLayerOpacityChanged,
  maskLayerPositivePromptChanged,
  maskLayerNegativePromptChanged,
  maskLayerPreviewColorChanged
);

// These are used to group actions into logical lines below (hate typos)
const LINE_1 = 'LINE_1';
const LINE_2 = 'LINE_2';

export const controlLayersUndoableConfig: UndoableOptions<ControlLayersState, UnknownAction> = {
  limit: 64,
  undoType: controlLayersSlice.actions.undo.type,
  redoType: controlLayersSlice.actions.redo.type,
  groupBy: (action, state, history) => {
    // Lines are started with `maskLayerLineAdded` and may have any number of subsequent `maskLayerPointsAdded` events.
    // We can use a double-buffer-esque trick to group each "logical" line as a single undoable action, without grouping
    // separate logical lines as a single undo action.
    if (maskLayerLineAdded.match(action)) {
      return history.group === LINE_1 ? LINE_2 : LINE_1;
    }
    if (maskLayerPointsAdded.match(action)) {
      if (history.group === LINE_1 || history.group === LINE_2) {
        return history.group;
      }
    }
    if (undoableGroupByMatcher(action)) {
      return action.type;
    }
    return null;
  },
  filter: (action, _state, _history) => {
    // Ignore all actions from other slices
    if (!action.type.startsWith(controlLayersSlice.name)) {
      return false;
    }
    // This action is triggered on state changes, including when we undo. If we do not ignore this action, when we
    // undo, this action triggers and empties the future states array. Therefore, we must ignore this action.
    if (layerBboxChanged.match(action)) {
      return false;
    }
    return true;
  },
};
