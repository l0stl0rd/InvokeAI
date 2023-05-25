/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { ImageField } from './ImageField';
import type { InvocationMeta } from './InvocationMeta';

/**
 * Restores faces in an image.
 */
export type RestoreFaceInvocation = {
  /**
   * The id of this node. Must be unique among all nodes.
   */
  id: string;
  type?: 'restore_face';
  /**
   * The meta properties of this node.
   */
  meta?: InvocationMeta;
  /**
   * The input image
   */
  image?: ImageField;
  /**
   * The strength of the restoration
   */
  strength?: number;
};

