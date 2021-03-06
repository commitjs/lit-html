/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

/**
 * @module lit-html
 */

import { isCEPolyfill } from './dom.js';
import { Part } from './part.js';
import { RenderOptions } from './render-options.js';
import { TemplateProcessor } from './template-processor.js';
import { isTemplatePartActive, Template, TemplatePart, mark } from './template.js';
import { customElementOpeningTagRe } from './utils.js';
// import { customElementClosingTagRegex } from './utils.js';


/**
 * An instance of a `Template` that can be attached to the DOM and updated
 * with new values.
 */
export class TemplateInstance {
  private readonly __parts: Array<Part | undefined> = [];
  readonly processor: TemplateProcessor;
  readonly options: RenderOptions;
  readonly template: Template;
  readonly context: any;

  constructor(
    template: Template, processor: TemplateProcessor,
    options: RenderOptions, context?: any) {
    this.template = template;
    this.processor = processor;
    this.options = options;
    this.context = context;
  }

  updateWithoutCommit(values: readonly unknown[]) {
    let i = 0;
    for (const part of this.__parts) {
      if (part !== undefined) {
        part.setValue(values[i]);
      }
      i++;
    }
    return this.__parts;
  }

  update(values: readonly unknown[]) {
    let i = 0;
    for (const part of this.__parts) {
      if (part !== undefined) {
        part.setValue(values[i]);
      }
      i++;
    }
    for (const part of this.__parts) {
      if (part !== undefined) {
        part.commit();
      }
    }
  }

  _clone(): DocumentFragment {
    // There are a number of steps in the lifecycle of a template instance's
    // DOM fragment:
    //  1. Clone - create the instance fragment
    //  2. Adopt - adopt into the main document
    //  3. Process - find part markers and create parts
    //  4. Upgrade - upgrade custom elements
    //  5. Update - set node, attribute, property, etc., values
    //  6. Connect - connect to the document. Optional and outside of this
    //     method.
    //
    // We have a few constraints on the ordering of these steps:
    //  * We need to upgrade before updating, so that property values will pass
    //    through any property setters.
    //  * We would like to process before upgrading so that we're sure that the
    //    cloned fragment is inert and not disturbed by self-modifying DOM.
    //  * We want custom elements to upgrade even in disconnected fragments.
    //
    // Given these constraints, with full custom elements support we would
    // prefer the order: Clone, Process, Adopt, Upgrade, Update, Connect
    //
    // But Safari does not implement CustomElementRegistry#upgrade, so we
    // can not implement that order and still have upgrade-before-update and
    // upgrade disconnected fragments. So we instead sacrifice the
    // process-before-upgrade constraint, since in Custom Elements v1 elements
    // must not modify their light DOM in the constructor. We still have issues
    // when co-existing with CEv0 elements like Polymer 1, and with polyfills
    // that don't strictly adhere to the no-modification rule because shadow
    // DOM, which may be created in the constructor, is emulated by being placed
    // in the light DOM.
    //
    // The resulting order is on native is: Clone, Adopt, Upgrade, Process,
    // Update, Connect. document.importNode() performs Clone, Adopt, and Upgrade
    // in one step.
    //
    // The Custom Elements v1 polyfill supports upgrade(), so the order when
    // polyfilled is the more ideal: Clone, Process, Adopt, Upgrade, Update,
    // Connect.

    const fragment = isCEPolyfill ?
      this.template.element.content.cloneNode(true) as DocumentFragment :
      document.importNode(this.template.element.content, true);

    const stack: Node[] = [];
    const parts = this.template.parts;
    // Edge needs all 4 parameters present; IE11 needs 3rd parameter to be null
    const walker = document.createTreeWalker(
      fragment,
      133 /* NodeFilter.SHOW_{ELEMENT|COMMENT|TEXT} */,
      null,
      false);
    let partIndex = 0;
    let nodeIndex = 0;
    let part: TemplatePart;
    let node = walker.nextNode();

    let customElementsCount = this.template.element.innerHTML.match(customElementOpeningTagRe)?.length || 0;

    // Loop through all the nodes and parts of a template
    while (partIndex < parts.length + customElementsCount) {
      part = parts[partIndex];
      if (part && !isTemplatePartActive(part)) {
        this.__parts.push(undefined);
        partIndex++;
        continue;
      }

      // Progress the tree walker until we find our next part's node.
      // Note that multiple parts may share the same node (attribute parts
      // on a single element), so this loop may not run at all.
      while (part && nodeIndex < part.index) {
        nodeIndex++;
        if (node!.nodeName === 'TEMPLATE') {
          stack.push(node!);
          walker.currentNode = (node as HTMLTemplateElement).content;
        }
        if ((node = walker.nextNode()) === null) {
          // We've exhausted the content inside a nested template element.
          // Because we still have parts (the outer for-loop), we know:
          // - There is a template in the stack
          // - The walker will find a nextNode outside the template
          walker.currentNode = stack.pop()!;
          node = walker.nextNode();
        }
      }
      if (!part) {
        node = walker.nextNode();
      }

      const isCustomElement = node?.nodeType === 1 && (node as any).localName.includes(mark);
      if (isCustomElement && this.context) {
        customElementsCount--;

        const selector = (node as any).localName.replace(`${mark}-`, '');
        const ctor = this.context.declarations[selector];
        if (!ctor && !customElements.get(selector)) {
          throw new Error(`Make sure that you've added ${selector} into declarations!`);
        }
        const instance = new ctor(this.context);
        const oldNode = node;
        node?.parentNode?.replaceChild(instance, node);
        (instance as Element).textContent = (oldNode as Element).innerHTML;
        const attributes = (oldNode as Element).attributes;
        for (let i = 0; i < attributes.length; i++) {
          const attr = attributes[i];
          (oldNode as Element).removeAttributeNode(attr);
          (instance as Element).setAttributeNode(attr);
        }
        node = instance as Element;
        walker.currentNode = node;
      }

      // We've arrived at our part's node.
      if (part && part.type === 'node') {
        const textPart =
          this.processor.handleTextExpression(this.options, part);
        textPart.insertAfterNode(node!.previousSibling!);
        this.__parts.push(textPart);
        partIndex++;
      } else if (part) {
        this.__parts.push(...this.processor.handleAttributeExpressions(node as Element, part.name, part.strings, this.options, part));
        partIndex++;
      }

    }


    if (isCEPolyfill) {
      document.adoptNode(fragment);
      customElements.upgrade(fragment);
    }
    return fragment;
  }
}
