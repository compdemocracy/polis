import reactEasyEmoji from 'react-easy-emoji'

// react-easy-emoji draws each emoji as a Twemoji 14.0.2 image. By default it
// loads that image from a CDN; these options load the same files from this
// client's own assets (public/twemoji/14.0.2/72x72), which hold exactly the
// images the app uses. A new emoji needs its PNG copied there.
//
// Twemoji graphics: Copyright 2019 Twitter, Inc and other contributors,
// licensed under CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/),
// from https://github.com/twitter/twemoji (maintained fork:
// https://github.com/jdecked/twemoji). The licence is kept beside the images
// in public/twemoji/14.0.2/LICENSE.txt and credited in the lander footer.
export const TWEMOJI_BASE_URL = '/twemoji/14.0.2/'

const options = { baseUrl: TWEMOJI_BASE_URL, protocol: '', size: '72x72', ext: '.png' }

export default function emoji(input) {
  return reactEasyEmoji(input, options)
}
