import DefaultTheme from 'vitepress/theme'
import { defineComponent, h } from 'vue'

import SiteFooter from './SiteFooter.vue'

export default defineComponent({
  setup() {
    return () => h(DefaultTheme.Layout, null, { 'doc-after': () => h(SiteFooter) })
  },
})
