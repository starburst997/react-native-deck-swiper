import isEqual from 'lodash/isEqual'
import PropTypes from 'prop-types'
import { Component } from 'react'
import { Animated, Dimensions, Easing, InteractionManager, StyleSheet, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'

import styles from './styles'

const { height, width } = Dimensions.get('window')
const LABEL_TYPES = {
  NONE: 'none',
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'top',
  BOTTOM: 'bottom'
}
const SWIPE_MULTIPLY_FACTOR = 4

const calculateCardIndexes = (firstCardIndex, cards) => {
  firstCardIndex = firstCardIndex || 0
  const previousCardIndex = firstCardIndex === 0 ? cards.length - 1 : firstCardIndex - 1
  const secondCardIndex = firstCardIndex === cards.length - 1 ? 0 : firstCardIndex + 1
  return { firstCardIndex, secondCardIndex, previousCardIndex }
}

const rebuildStackAnimatedValues = (props) => {
  const stackPositionsAndScales = {}
  const { stackSize, stackSeparation, stackScale } = props

  for (let position = 0; position < stackSize; position++) {
    stackPositionsAndScales[`stackPosition${position}`] = new Animated.Value(stackSeparation * position)
    stackPositionsAndScales[`stackScale${position}`] = new Animated.Value((100 - stackScale * position) * 0.01)
  }

  return stackPositionsAndScales
}

class Swiper extends Component {
  constructor (props) {
    super(props)

    this.state = {
      ...calculateCardIndexes(props.cardIndex, props.cards),
      pan: new Animated.ValueXY(),

      previousCardX: new Animated.Value(props.previousCardDefaultPositionX),
      previousCardY: new Animated.Value(props.previousCardDefaultPositionY),
      swipedAllCards: false,
      panResponderLocked: false,
      labelType: LABEL_TYPES.NONE,
      slideGesture: false,
      swipeBackXYPositions: [],
      isSwipingBack: false,
      // Track total swipes for slot rotation
      swipedCount: 0,
      ...rebuildStackAnimatedValues(props)
    }

    this._mounted = true
    this._animatedValueX = 0
    this._animatedValueY = 0
    this._lastEmittedDirection = null
    // True for the whole lifetime of a gesture that began while a card was
    // still flying out. Such a gesture must never touch `pan` (see
    // onGestureStart) — not on start, not on move, not on release.
    this._gestureIgnored = false
    // Synchronous mirror of state.panResponderLocked. setState only lands on
    // the next render, so a second swipe (or a gesture) firing in the same tick
    // would still read the lock as open and hijack the flight mid-air.
    this._swipeInFlight = false

    // Regular z-index values for each slot - NOT Animated.Value since z-index shouldn't interpolate
    this._slotZIndexes = Array.from({ length: props.stackSize }, (_, i) =>
      props.stackSize - i // slot 0 = highest, slot 1 = second, etc.
    )

    // Animated opacity for each slot - used for fade-in when card returns to bottom of stack
    this._slotOpacities = Array.from({ length: props.stackSize }, () =>
      new Animated.Value(1)
    )

    // Cache rendered card content - only update when slot goes to bottom
    this._slotCardIndexes = Array.from({ length: props.stackSize }, (_, i) => props.cardIndex + i)
    this._slotContents = Array.from({ length: props.stackSize }, (_, i) => {
      const cardIndex = props.cardIndex + i
      if (cardIndex < props.cards.length) {
        return props.renderCard(props.cards[cardIndex], cardIndex)
      } else {
        return props.renderCard(props.cards[props.cards.length - 1], props.cards.length - 1)
      }
    })

    this.state.pan.x.addListener(value => (this._animatedValueX = value.value))
    this.state.pan.y.addListener(value => (this._animatedValueY = value.value))

    this.initializeCardStyle()
    this.initializeGesture()
  }

  initializeGesture = () => {
    this._panGesture = Gesture.Pan()
      .runOnJS(true)
      .onStart(() => {
        this.onGestureStart()
      })
      .onUpdate((event) => {
        this.onGestureMove(event.translationX, event.translationY)
      })
      .onEnd((event) => {
        this.onGestureEnd(event.translationX, event.translationY, event.velocityX, event.velocityY)
      })
      .minDistance(5)
      .activeOffsetX([-10, 10])
      .activeOffsetY([-10, 10])
  }

  shouldComponentUpdate = (nextProps, nextState) => {
    const { props, state } = this
    const propsChanged = (
      !isEqual(props.cards, nextProps.cards) ||
      props.cardIndex !== nextProps.cardIndex
    )
    const stateChanged = (
      nextState.firstCardIndex !== state.firstCardIndex ||
      nextState.secondCardIndex !== state.secondCardIndex ||
      nextState.previousCardIndex !== state.previousCardIndex ||
      nextState.labelType !== state.labelType ||
      nextState.swipedAllCards !== state.swipedAllCards ||
      nextState.swipedCount !== state.swipedCount
    )
    return propsChanged || stateChanged
  }

  componentWillUnmountAfterInteractions = () => {
    this.state.pan.x.removeAllListeners()
    this.state.pan.y.removeAllListeners()
    this.dimensionsChangeSubscription?.remove()
  }

  componentWillUnmount = () => {
    this._mounted = false;
    InteractionManager.runAfterInteractions(this.componentWillUnmountAfterInteractions.bind(this));
  }

  getCardStyle = () => {
    const { height, width } = Dimensions.get('window')
    const {
      cardVerticalMargin,
      cardHorizontalMargin,
      marginTop,
      marginBottom
    } = this.props

    const cardWidth = width - cardHorizontalMargin * 2
    const cardHeight =
      height - cardVerticalMargin * 2 - marginTop - marginBottom

    return {
      top: cardVerticalMargin,
      left: cardHorizontalMargin,
      width: cardWidth,
      height: cardHeight
    }
  }

  initializeCardStyle = () => {
    // this.forceUpdate()
    this.dimensionsChangeSubscription = Dimensions.addEventListener('change', this.onDimensionsChange)
  }

  onGestureStart = () => {
    // A card is still flying out: `pan` is owned by that animation, and
    // Animated.Value.setValue() STOPS whatever animation is running on it. The
    // old code called setValue here unconditionally, so touching the deck
    // mid-flight killed the fly-out in place — the card froze half-faded and
    // then vanished when the (now instantly-finished) animation recycled it.
    // That was the "hiccup": the transition visibly never reached its end.
    // Mark the whole gesture inert instead, so its later move/release frames
    // can't hijack `pan` either once the lock releases mid-gesture.
    if (this._swipeInFlight || this.state.panResponderLocked) {
      this._gestureIgnored = true
      return
    }
    this._gestureIgnored = false
    this.props.dragStart && this.props.dragStart()
    this.state.pan.setOffset({ x: 0, y: 0 })
    this.state.pan.setValue({ x: 0, y: 0 })
  }

  onGestureMove = (dx, dy) => {
    if (this._gestureIgnored || this._swipeInFlight || this.state.panResponderLocked) return

    const { horizontalSwipe, verticalSwipe } = this.props

    // Update the animated values
    const x = horizontalSwipe ? dx : 0
    const y = verticalSwipe ? dy : 0
    this.state.pan.setValue({ x, y })

    // Update internal tracking
    this._animatedValueX = x
    this._animatedValueY = y

    this.props.onSwiping(x, y)

    // Emit the resolved commit-direction so a consumer can mirror it (e.g. a
    // grade-button hover) using the exact logic release will commit with — only
    // when it changes, to avoid spamming setState on every move frame.
    const resolvedDirection = this.getResolvedSwipeDirection(x, y)
    if (resolvedDirection !== this._lastEmittedDirection) {
      this._lastEmittedDirection = resolvedDirection
      this.props.onSwipeDirection(resolvedDirection)
    }

    let { overlayOpacityHorizontalThreshold, overlayOpacityVerticalThreshold } = this.props
    if (!overlayOpacityHorizontalThreshold) {
      overlayOpacityHorizontalThreshold = this.props.horizontalThreshold
    }
    if (!overlayOpacityVerticalThreshold) {
      overlayOpacityVerticalThreshold = this.props.verticalThreshold
    }

    let isSwipingLeft, isSwipingRight, isSwipingTop, isSwipingBottom

    if (Math.abs(x) > Math.abs(y) && Math.abs(x) > overlayOpacityHorizontalThreshold || true) {
      if (x > 0) isSwipingRight = true
      else isSwipingLeft = true
    } else if (Math.abs(y) > Math.abs(x) && Math.abs(y) > overlayOpacityVerticalThreshold) {
      if (y > 0) isSwipingBottom = true
      else isSwipingTop = true
    }

    // Only write state that actually changed: this runs on EVERY move frame,
    // and a same-value setState still costs a full React update pass (plus a
    // shouldComponentUpdate over the whole card array) for no rendered change.
    const labelType = isSwipingRight
      ? LABEL_TYPES.RIGHT
      : isSwipingLeft
        ? LABEL_TYPES.LEFT
        : isSwipingTop
          ? LABEL_TYPES.TOP
          : isSwipingBottom
            ? LABEL_TYPES.BOTTOM
            : LABEL_TYPES.NONE

    if (labelType !== this.state.labelType) {
      this.setState({ labelType })
    }

    const { onTapCardDeadZone } = this.props
    if (
      !this.state.slideGesture &&
      (x < -onTapCardDeadZone ||
        x > onTapCardDeadZone ||
        y < -onTapCardDeadZone ||
        y > onTapCardDeadZone)
    ) {
      this.setState({ slideGesture: true })
    }
  }

  onGestureEnd = (dx, dy, velocityX, velocityY) => {
    // Inert gesture — it either began during a fly-out or one started under it.
    // Never reset `pan` here: it belongs to the in-flight animation and
    // setValue would cut it short. Also never grade or tap-flip from it.
    if (this._gestureIgnored || this._swipeInFlight || this.state.panResponderLocked) {
      this._gestureIgnored = false
      return
    }

    this.props.dragEnd && this.props.dragEnd()

    const x = this.props.horizontalSwipe ? dx : 0
    const y = this.props.verticalSwipe ? dy : 0

    // Commit direction comes from the SAME resolver that drives the live
    // onSwipeDirection intent during the drag, so what lit up is exactly what
    // commits — no separate threshold logic that can disagree.
    const direction = this.getResolvedSwipeDirection(x, y)
    const disabledByDirection = {
      left: this.props.disableLeftSwipe,
      right: this.props.disableRightSwipe,
      top: this.props.disableTopSwipe,
      bottom: this.props.disableBottomSwipe
    }
    const callbackByDirection = {
      left: this.props.onSwipedLeft,
      right: this.props.onSwipedRight,
      top: this.props.onSwipedTop,
      bottom: this.props.onSwipedBottom
    }

    if (direction && !disabledByDirection[direction]) {
      // Throw along the ACTUAL release position + momentum — swipeCard's default
      // x/y are the live _animatedValueX/Y, so the card keeps flying the exact
      // way it was flicked (the original buttery feel). Never pass synthetic
      // threshold coordinates here: that straightens the arc to y=0 and cans the
      // throw to a fixed distance, which is what wrecked the feel.
      this.swipeCard(callbackByDirection[direction])
    } else {
      this.resetTopCard()
    }

    if (!this.state.slideGesture) {
      this.props.onTapCard(this.state.firstCardIndex)
    }

    this.setState({
      labelType: LABEL_TYPES.NONE,
      slideGesture: false
    })

    // Intent is over — tell consumers to clear their hover.
    this._lastEmittedDirection = null
    this.props.onSwipeDirection(null)
  }

  onDimensionsChange = () => {
    this.forceUpdate()
  }

  validPanResponderRelease = () => {
    const {
      disableBottomSwipe,
      disableLeftSwipe,
      disableRightSwipe,
      disableTopSwipe
    } = this.props

    const {
      isSwipingLeft,
      isSwipingRight,
      isSwipingTop,
      isSwipingBottom
    } = this.getSwipeDirection(this._animatedValueX, this._animatedValueY)

    return (
      (isSwipingLeft && !disableLeftSwipe) ||
      (isSwipingRight && !disableRightSwipe) ||
      (isSwipingTop && !disableTopSwipe) ||
      (isSwipingBottom && !disableBottomSwipe)
    )
  }

  getOnSwipeDirectionCallback = (animatedValueX, animatedValueY) => {
    const {
      onSwipedLeft,
      onSwipedRight,
      onSwipedTop,
      onSwipedBottom
    } = this.props

    const {
      isSwipingLeft,
      isSwipingRight,
      isSwipingTop,
      isSwipingBottom
    } = this.getSwipeDirection(animatedValueX, animatedValueY)

    if (isSwipingRight) {
      return onSwipedRight
    }

    if (isSwipingLeft) {
      return onSwipedLeft
    }

    if (isSwipingTop) {
      return onSwipedTop
    }

    if (isSwipingBottom) {
      return onSwipedBottom
    }
  }

  mustDecrementCardIndex = (animatedValueX, animatedValueY) => {
    const {
      isSwipingLeft,
      isSwipingRight,
      isSwipingTop,
      isSwipingBottom
    } = this.getSwipeDirection(animatedValueX, animatedValueY)

    return (
      (isSwipingLeft && this.props.goBackToPreviousCardOnSwipeLeft) ||
      (isSwipingRight && this.props.goBackToPreviousCardOnSwipeRight) ||
      (isSwipingTop && this.props.goBackToPreviousCardOnSwipeTop) ||
      (isSwipingBottom && this.props.goBackToPreviousCardOnSwipeBottom)
    )
  }

  // Single source of truth for BOTH the live intent (onSwipeDirection, emitted
  // during the drag) and the direction committed on release, so the hover a
  // consumer paints and the graded outcome can never disagree. Returns
  // 'left' | 'right' | 'top' | 'bottom' | null.
  getResolvedSwipeDirection = (x, y) => {
    const {
      horizontalThreshold,
      verticalThreshold,
      redirectBottomToHorizontal,
      bottomSwipeHorizontalThreshold
    } = this.props
    // Horizontal wins the moment it passes its threshold, whatever the vertical.
    if (x <= -horizontalThreshold) return 'left'
    if (x >= horizontalThreshold) return 'right'
    // Upward past the vertical threshold.
    if (y <= -verticalThreshold) return 'top'
    // Downward has no dedicated action: fold it into left/right (never snap
    // back to "nothing"). It commits when EITHER:
    //  (a) there's a slight horizontal lean (|x| past bottomSwipeHorizontalThreshold)
    //      — commits early, so a light down-left/right registers with no dead zone; or
    //  (b) the drag has gone down past the vertical threshold — commits regardless
    //      of lean, even straight down.
    // Side is the sign of x, defaulting to LEFT at exactly 0.
    if (
      redirectBottomToHorizontal &&
      y > 0 &&
      (Math.abs(x) >= bottomSwipeHorizontalThreshold) || (y >= verticalThreshold && Math.abs(x) >= 2)
    ) {
      return x <= 0 ? 'left' : 'right'
    }
    // Straight down past the vertical threshold with redirect disabled — bottom.
    if (y >= verticalThreshold) return 'bottom'
    return null
  }

  getSwipeDirection = (animatedValueX, animatedValueY) => {
    const isSwipingLeft = animatedValueX < -this.props.horizontalThreshold
    const isSwipingRight = animatedValueX > this.props.horizontalThreshold
    const isSwipingTop = animatedValueY < -this.props.verticalThreshold
    const isSwipingBottom = animatedValueY > this.props.verticalThreshold

    return { isSwipingLeft, isSwipingRight, isSwipingTop, isSwipingBottom }
  }

  resetTopCard = cb => {
    Animated.spring(this.state.pan, {
      toValue: 0,
      friction: this.props.topCardResetAnimationFriction,
      tension: this.props.topCardResetAnimationTension,
      useNativeDriver: true
    }).start(cb)

    this.state.pan.setOffset({
      x: 0,
      y: 0
    })

    this.props.onSwipedAborted()
  }

  swipeBack = cb => {
    const { swipeBackXYPositions, isSwipingBack } = this.state
    const { infinite } = this.props
    const canSwipeBack = !isSwipingBack && (swipeBackXYPositions.length > 0 || infinite)
    if (!canSwipeBack) {
      return
    }
    this.setState({isSwipingBack: !isSwipingBack, swipeBackXYPositions}, () => {
      this.animatePreviousCard(this.calculateNextPreviousCardPosition(), cb)
    })
  }

  swipeLeft = (mustDecrementCardIndex = false) => {
    this.swipeCard(
      this.props.onSwipedLeft,
      -this.props.horizontalThreshold,
      0,
      mustDecrementCardIndex
    )
  }

  swipeRight = (mustDecrementCardIndex = false) => {
    this.swipeCard(
      this.props.onSwipedRight,
      this.props.horizontalThreshold,
      0,
      mustDecrementCardIndex
    )
  }

  swipeTop = (mustDecrementCardIndex = false) => {
    this.swipeCard(
      this.props.onSwipedTop,
      0,
      -this.props.verticalThreshold,
      mustDecrementCardIndex
    )
  }

  swipeBottom = (mustDecrementCardIndex = false) => {
    this.swipeCard(
      this.props.onSwipedBottom,
      0,
      this.props.verticalThreshold,
      mustDecrementCardIndex
    )
  }

  // How far a released card is thrown. The release vector sets the DIRECTION
  // (and the arc — never straighten it); a uniform scale sets the DISTANCE, so
  // the card always carries fully past the screen edge instead of stopping
  // wherever `release * 4` happened to land. Short commits — a light flick, or
  // a tap-to-grade, which starts at exactly the threshold — used to end their
  // flight still half on screen and clearly visible, and the card then blinked
  // out on the spot. Hard flicks keep the original factor as a floor, so their
  // (already off-screen) throw is untouched.
  calculateThrowTarget = (x, y) => {
    const { height: windowHeight, width: windowWidth } = Dimensions.get('window')
    const defaultCardStyle = this.getCardStyle()
    const cardStyle = this.props.cardStyle || {}
    const cardWidth = typeof cardStyle.width === 'number' ? cardStyle.width : defaultCardStyle.width
    const cardHeight = typeof cardStyle.height === 'number' ? cardStyle.height : defaultCardStyle.height

    // Travel that takes a (roughly centered) card fully past the edge, plus a
    // margin for the rotation it picks up on the way out.
    const escapeX = (windowWidth + cardWidth) / 2 + 40
    const escapeY = (windowHeight + cardHeight) / 2 + 40

    // Smallest uniform scale that clears whichever edge the card is heading
    // for. Uniform = the arc stays exactly as it was flicked.
    const scale = Math.min(
      Math.abs(x) > 0 ? escapeX / Math.abs(x) : Infinity,
      Math.abs(y) > 0 ? escapeY / Math.abs(y) : Infinity
    )
    const factor = Number.isFinite(scale)
      ? Math.max(SWIPE_MULTIPLY_FACTOR, scale)
      : SWIPE_MULTIPLY_FACTOR

    return { x: x * factor, y: y * factor }
  }

  swipeCard = (
    onSwiped,
    x = this._animatedValueX,
    y = this._animatedValueY,
    mustDecrementCardIndex = false
  ) => {
    // Ignore any swipe fired while one is already animating. The drag path
    // guards on this lock (see onGestureEnd), but the public swipeLeft/Right/
    // Top/Bottom methods used by tap-to-grade buttons did not — so rapid taps
    // stacked overlapping animations, each calling incrementCardIndex, and
    // over-advanced the index straight into onSwipedAll, ending the session
    // unexpectedly. A single swipe must fully complete before the next starts.
    if (this._swipeInFlight || this.state.panResponderLocked) return
    this._swipeInFlight = true
    this.setState({ panResponderLocked: true })
    this.animateStack()

    const { stackSize } = this.props
    // The slot that is flying out. Safe to resolve up-front: swipedCount only
    // moves in setCardIndex, which can't run until this flight completes.
    const swipedSlot = this.state.swipedCount % stackSize

    // Flight and fade are ONE animation over ONE window: the card keeps moving
    // past the screen edge and lands on opacity 0 at the exact frame the
    // movement stops — no dead pause, no visible card snapped out of existence
    // mid-fade. The slot is only put back under the pile from the completion
    // callback, so a card can never be recycled while its animation is running.
    Animated.parallel([
      Animated.timing(this.state.pan, {
        toValue: this.calculateThrowTarget(x, y),
        duration: this.props.swipeAnimationDuration,
        useNativeDriver: true
      }),
      Animated.timing(this._slotOpacities[swipedSlot], {
        toValue: 0,
        duration: this.props.swipeAnimationDuration,
        // Linear against the eased flight reads as a steady fade while the
        // card flies away; an eased fade instead lingers just above 0.
        easing: Easing.linear,
        useNativeDriver: true
      })
    ]).start(({ finished }) => {
      // Card is off-screen at opacity 0 — safe to put the slot back under the
      // pile. Re-assign z-indexes so the swiped slot becomes the bottom one.
      const newTopSlot = (this.state.swipedCount + 1) % stackSize
      for (let i = 0; i < stackSize; i++) {
        const distanceFromTop = (i - newTopSlot + stackSize) % stackSize
        this._slotZIndexes[i] = stackSize - distanceFromTop
      }

      // Interrupted flight (unmount, or a competing animation on pan): pin the
      // slot invisible anyway, so it can't reappear where it was dropped.
      if (!finished) {
        this._slotOpacities[swipedSlot].setValue(0)
      }

      // Apply the new z-indexes. The slot stays at opacity 0 until its content
      // has been swapped for the next card and it has faded back in at the
      // bottom (setCardIndex), so no frame in between can show a stale card.
      this.forceUpdate()

      this.setSwipeBackCardXY(x, y, () => {
        mustDecrementCardIndex = mustDecrementCardIndex
          ? true
          : this.mustDecrementCardIndex(
              this._animatedValueX,
              this._animatedValueY
            )

        if (mustDecrementCardIndex) {
          this.decrementCardIndex(onSwiped)
        } else {
          this.incrementCardIndex(onSwiped)
        }
      })
    })
  }

  setSwipeBackCardXY = (x = -width, y = 0, cb) => {
    this.setState({swipeBackXYPositions: [...this.state.swipeBackXYPositions, {x, y}]}, cb)
  }

  animatePreviousCard = ({x, y}, cb) => {
    const { previousCardX, previousCardY } = this.state
    previousCardX.setValue(x * SWIPE_MULTIPLY_FACTOR)
    previousCardY.setValue(y * SWIPE_MULTIPLY_FACTOR)
    Animated.parallel([
      Animated.spring(this.state.previousCardX, {
        toValue: 0,
        friction: this.props.stackAnimationFriction,
        tension: this.props.stackAnimationTension,
        useNativeDriver: true
      }),
      Animated.spring(this.state.previousCardY, {
        toValue: 0,
        friction: this.props.stackAnimationFriction,
        tension: this.props.stackAnimationTension,
        useNativeDriver: true
      })
    ]).start(() => {
      this.setState({isSwipingBack: false})
      this.decrementCardIndex(cb)
    })
  }

  animateStack = () => {
    const { secondCardIndex, swipedAllCards } = this.state
    let { stackSize, infinite, showSecondCard, cards } = this.props
    let index = secondCardIndex

    while (stackSize-- > 1 && showSecondCard && !swipedAllCards) {
      if (this.state[`stackPosition${stackSize}`] && this.state[`stackScale${stackSize}`]) {
        const newSeparation = this.props.stackSeparation * (stackSize - 1)
        const newScale = (100 - this.props.stackScale * (stackSize - 1)) * 0.01
        Animated.parallel([
          Animated.spring(this.state[`stackPosition${stackSize}`], {
            toValue: newSeparation,
            friction: this.props.stackAnimationFriction,
            tension: this.props.stackAnimationTension,
            useNativeDriver: true
          }),
          Animated.spring(this.state[`stackScale${stackSize}`], {
            toValue: newScale,
            friction: this.props.stackAnimationFriction,
            tension: this.props.stackAnimationTension,
            useNativeDriver: true
          })
        ]).start()
      }

      if (index === cards.length - 1) {
        if (!infinite) break
        index = 0
      } else {
        index++
      }
    }
  }

  incrementCardIndex = onSwiped => {
    const { firstCardIndex } = this.state
    const { infinite } = this.props
    let newCardIndex = firstCardIndex + 1
    let swipedAllCards = false

    this.onSwipedCallbacks(onSwiped)

    const allSwipedCheck = () => newCardIndex === this.props.cards.length

    if (allSwipedCheck()) {
      if (!infinite) {
        this.props.onSwipedAll()
        // onSwipeAll may have added cards
        if (allSwipedCheck()) {
          swipedAllCards = true
        }
      } else {
        newCardIndex = 0;
      }
    }

    this.setCardIndex(newCardIndex, swipedAllCards)
  }

  decrementCardIndex = cb => {
    const { firstCardIndex } = this.state
    const lastCardIndex = this.props.cards.length - 1
    const previousCardIndex = firstCardIndex - 1

    const newCardIndex =
      firstCardIndex === 0 ? lastCardIndex : previousCardIndex

    this.onSwipedCallbacks(cb)
    this.setCardIndex(newCardIndex, false)
  }

  jumpToCardIndex = newCardIndex => {
    if (this.props.cards[newCardIndex]) {
      this.setCardIndex(newCardIndex, false)
    }
  }
  rebuildStackValues = () => {
    const stackPositionsAndScales = {}
    const { stackSize, stackSeparation, stackScale } = this.props
    for (let position = 0; position < stackSize; position++) {
      stackPositionsAndScales[`stackPosition${position}`] = new Animated.Value(stackSeparation * position)
      stackPositionsAndScales[`stackScale${position}`] = new Animated.Value((100 - stackScale * position) * 0.01)
    }
    return stackPositionsAndScales
  }

  onSwipedCallbacks = (swipeDirectionCallback) => {
    const previousCardIndex = this.state.firstCardIndex
    this.props.onSwiped(previousCardIndex, this.props.cards[previousCardIndex])
    this.setState(this.rebuildStackValues)
    if (swipeDirectionCallback) {
      swipeDirectionCallback(previousCardIndex, this.props.cards[previousCardIndex])
    }
  }

  setCardIndex = (newCardIndex, swipedAllCards) => {
    if (this._mounted) {
      const { swipedCount } = this.state
      const { stackSize, cards, renderCard } = this.props

      // The slot that was just swiped (goes to bottom)
      const swipedSlot = swipedCount % stackSize

      // Z-indexes were already updated in swipeCard() before animation started
      // Just reset pan - the swiped card is already at bottom z-index
      this.state.pan.setValue({ x: 0, y: 0 })
      this.state.pan.setOffset({ x: 0, y: 0 })
      this._animatedValueX = 0
      this._animatedValueY = 0

      // Only update the cached content for the slot going to the bottom
      const bottomCardIndex = newCardIndex + stackSize - 1
      if (bottomCardIndex < cards.length) {
        this._slotCardIndexes[swipedSlot] = bottomCardIndex
        this._slotContents[swipedSlot] = renderCard(cards[bottomCardIndex], bottomCardIndex)
      } else {
        this._slotCardIndexes[swipedSlot] = bottomCardIndex
        this._slotContents[swipedSlot] = renderCard(cards[cards.length - 1], cards.length - 1)
      }

      this.setState(
        {
          ...calculateCardIndexes(newCardIndex, this.props.cards),
          swipedAllCards: swipedAllCards,
          panResponderLocked: false,
          swipedCount: swipedCount + 1
        },
        () => {
          this.resetPanAndScale()

          // Fade in the swiped slot (now at bottom of stack). Only now — the
          // slot holds the NEXT card and sits under the whole pile — is the
          // recycle actually complete, so this is where the lock opens.
          Animated.timing(this._slotOpacities[swipedSlot], {
            toValue: 1,
            duration: 250,
            useNativeDriver: true
          }).start()

          this._swipeInFlight = false
        }
      )
    }
  }

  resetPanAndScale = () => {
    const {previousCardDefaultPositionX, previousCardDefaultPositionY} = this.props
    this.state.pan.setValue({ x: 0, y: 0 })
    this.state.pan.setOffset({ x: 0, y: 0})
    this._animatedValueX = 0
    this._animatedValueY = 0
    this.state.previousCardX.setValue(previousCardDefaultPositionX)
    this.state.previousCardY.setValue(previousCardDefaultPositionY)
    // NOTE: pan listeners are attached ONCE in the constructor and live until
    // unmount. The original library re-added them here, i.e. on every swipe —
    // so after N cards, N+1 listeners fired per animation frame (each one a
    // native → JS hop, since pan is native-driven). That is why a session got
    // progressively less smooth the longer you studied.
  }

  calculateNextPreviousCardPosition = () => {
    const { swipeBackXYPositions } = this.state
    let { previousCardDefaultPositionX: x, previousCardDefaultPositionY: y } = this.props
    const swipeBackPosition = swipeBackXYPositions.splice(-1, 1)
    if (swipeBackPosition[0]) {
      x = swipeBackPosition[0].x
      y = swipeBackPosition[0].y
    }
    return { x, y }
  }

  calculateOverlayLabelStyle = (isTop = false) => {
    const dynamicStyle = this.props.overlayLabels[this.state.labelType].style
    let overlayLabelStyle = dynamicStyle ? dynamicStyle.label : {}

    if (this.state.labelType === LABEL_TYPES.NONE || !isTop) {
      overlayLabelStyle = styles.hideOverlayLabel
    }

    return [this.props.overlayLabelStyle, overlayLabelStyle]
  }

  calculateOverlayLabelWrapperStyle = () => {
    const dynamicStyle = this.props.overlayLabels[this.state.labelType].style
    const dynamicWrapperStyle = dynamicStyle ? dynamicStyle.wrapper : {}

    const opacity = this.props.animateOverlayLabelsOpacity
      ? this.interpolateOverlayLabelsOpacity()
      : 1
    return [this.props.overlayLabelWrapperStyle, dynamicWrapperStyle, { opacity }]
  }

  calculateSwipableCardStyle = () => {
    const opacity = this.props.animateCardOpacity
      ? this.interpolateCardOpacity()
      : 1
    const rotation = this.interpolateRotation()

    return [
      styles.card,
      this.getCardStyle(),
      {
        zIndex: 1,
        opacity: opacity,
        transform: [
          { translateX: this.state.pan.x },
          { translateY: this.state.pan.y },
          { rotate: rotation }
        ]
      },
      this.props.cardStyle
    ]
  }

  calculateStackCardZoomStyle = (position) => [
    styles.card,
    this.getCardStyle(),
    {
      zIndex: position * -1,
      transform: [{ scale: this.state[`stackScale${position}`] }, { translateY: this.state[`stackPosition${position}`] }]
    },
    this.props.cardStyle
  ]

  calculateSwipeBackCardStyle = () => [
    styles.card,
    this.getCardStyle(),
    {
      zIndex: 4,
      transform: [
        { translateX: this.state.previousCardX },
        { translateY: this.state.previousCardY }
      ]
    },
    this.props.cardStyle
  ]

  interpolateCardOpacity = () => {
    const animatedValueX = Math.abs(this._animatedValueX)
    const animatedValueY = Math.abs(this._animatedValueY)
    let opacity

    if (animatedValueX > animatedValueY || true) {
      opacity = this.state.pan.x.interpolate({
        inputRange: this.props.inputCardOpacityRangeX,
        outputRange: this.props.outputCardOpacityRangeX
      })
    } else {
      opacity = this.state.pan.y.interpolate({
        inputRange: this.props.inputCardOpacityRangeY,
        outputRange: this.props.outputCardOpacityRangeY
      })
    }

    return opacity
  }

  interpolateOverlayLabelsOpacity = () => {
    const animatedValueX = Math.abs(this._animatedValueX)
    const animatedValueY = Math.abs(this._animatedValueY)
    let opacity

    if (animatedValueX > animatedValueY || true) {
      opacity = this.state.pan.x.interpolate({
        inputRange: this.props.inputOverlayLabelsOpacityRangeX,
        outputRange: this.props.outputOverlayLabelsOpacityRangeX
      })
    } else {
      opacity = this.state.pan.y.interpolate({
        inputRange: this.props.inputOverlayLabelsOpacityRangeY,
        outputRange: this.props.outputOverlayLabelsOpacityRangeY
      })
    }

    return opacity
  }

  interpolateRotation = () =>
    this.state.pan.x.interpolate({
      inputRange: this.props.inputRotationRange,
      outputRange: this.props.outputRotationRange
    })

  render = () => {
    const { pointerEvents, backgroundColor, marginTop, marginBottom, containerStyle, swipeBackCard, testID } = this.props

    return (
      <GestureDetector gesture={this._panGesture}>
        <View
          pointerEvents={pointerEvents}
          testID={testID}
          style={[
            styles.container,
            {
              backgroundColor: backgroundColor,
              marginTop: marginTop,
              marginBottom: marginBottom
            },
            containerStyle
          ]}
        >
          {/* {this.renderChildren()}
          {swipeBackCard ? this.renderSwipeBackCard() : null} */}
          {this.renderStack()}
        </View>
      </GestureDetector>
    )
  }

  renderChildren = () => {
    const { childrenOnTop, children, stackSize, showSecondCard } = this.props

    let zIndex = (stackSize && showSecondCard)
      ? stackSize * -1
      : 1

    if (childrenOnTop) {
      zIndex = 5
    }

    return (
      <View pointerEvents='box-none' style={[styles.childrenViewStyle, { zIndex: zIndex }]}>
        {children}
      </View>
    )
  }

  getCardKey = (cardContent, cardIndex) => {
    const { keyExtractor } = this.props

    if (keyExtractor) {
      return keyExtractor(cardContent)
    }

    return cardIndex
  }

  pushCardToStack = (renderedCards, index, position, key, firstCard) => {
    const { cards } = this.props
    const stackCardZoomStyle = this.calculateStackCardZoomStyle(position)
    const stackCard = this.props.renderCard(cards[index], index)
    const swipableCardStyle = this.calculateSwipableCardStyle()
    const renderOverlayLabel = this.renderOverlayLabel()

    if (firstCard) {
      renderedCards.push(
        <Animated.View key={key} style={swipableCardStyle}>
          {renderOverlayLabel}
          {stackCard}
        </Animated.View>
      )
    } else {
      renderedCards.push(
        <Animated.View key={key} style={stackCardZoomStyle}>
          {stackCard}
        </Animated.View>
      )
    }
  }

  pushCardToStackWithZIndex = (renderedCards, slot, key, isTopCard, position, isValidCard) => {
    // Use cached content - this never changes except when slot goes to bottom
    const stackCard = this._slotContents[slot]
    if (!stackCard) return

    // Get z-index for this slot (regular number, updated in swipeCard before animation)
    const slotZIndex = this._slotZIndexes[slot]
    const renderOverlayLabel = this.renderOverlayLabel(isTopCard)

    // DEBUG: Show slot number on each card
    const debugLabel = (
      <View style={debugStyles.debugContainer}>
        <Text style={debugStyles.debugText}>{slot}</Text>
      </View>
    )

    if (isTopCard) {
      // Top card uses pan transform and overlay
      const swipeOpacity = this.props.animateCardOpacity
        ? this.interpolateCardOpacity()
        : 1
      const rotation = this.interpolateRotation()

      // Combine swipe opacity with slot opacity (for fade-in effect)
      const combinedOpacity = this.props.animateCardOpacity
        ? Animated.multiply(swipeOpacity, this._slotOpacities[slot])
        : this._slotOpacities[slot]

      const topCardStyle = [
        styles.card,
        this.getCardStyle(),
        {
          zIndex: slotZIndex,
          opacity: combinedOpacity,
          transform: [
            { translateX: this.state.pan.x },
            { translateY: this.state.pan.y },
            { rotate: rotation }
          ]
        },
        this.props.cardStyle
      ]

      renderedCards.push(
        <Animated.View key={key} style={topCardStyle}>
          {renderOverlayLabel}
          {stackCard}
          {/* {debugLabel} */}
        </Animated.View>
      )
    } else {
      // Stack cards use z-index, slot opacity, and scale/position for stacking effect
      // Hide cards that don't have valid card data (beyond the end of the deck)
      const stackCardStyle = [
        styles.card,
        this.getCardStyle(),
        {
          zIndex: slotZIndex,
          opacity: isValidCard ? this._slotOpacities[slot] : 0,
          transform: [
            { scale: this.state[`stackScale${position}`] },
            { translateY: this.state[`stackPosition${position}`] }
          ]
        },
        this.props.cardStyle
      ]

      renderedCards.push(
        <Animated.View key={key} style={stackCardStyle}>
          {renderOverlayLabel}
          {stackCard}
          {/* {debugLabel} */}
        </Animated.View>
      )
    }
  }

  renderStack = () => {
    const { swipedAllCards, swipedCount, firstCardIndex } = this.state
    const { stackSize, showSecondCard, cards } = this.props

    if (swipedAllCards) {
      return []
    }

    // Which slot is currently on top?
    const topSlot = swipedCount % stackSize

    // Render all slots - z-index is handled by Animated.Value
    const renderedCards = []
    for (let slot = 0; slot < stackSize; slot++) {
      // Skip if no cached content
      if (!this._slotContents[slot]) {
        continue
      }

      const isTopCard = slot === topSlot

      // Skip non-top cards if showSecondCard is false
      if (!isTopCard && !showSecondCard) {
        continue
      }

      // Calculate this slot's position in the stack (0 = top, 1 = second, etc.)
      const position = (slot - topSlot + stackSize) % stackSize

      // Check if a card should exist at this stack position
      // The expected card index is firstCardIndex + position (0 for top, 1 for second, etc.)
      const expectedCardIndex = firstCardIndex + position
      const isValidCard = expectedCardIndex < cards.length

      const stableKey = `slot-${slot}`
      this.pushCardToStackWithZIndex(renderedCards, slot, stableKey, isTopCard, position, isValidCard)
    }

    return renderedCards
  }

  renderSwipeBackCard = () => {
    const { previousCardIndex } = this.state
    const { cards } = this.props
    const previousCardStyle = this.calculateSwipeBackCardStyle()
    const previousCard = this.props.renderCard(cards[previousCardIndex], previousCardIndex)
    const key = this.getCardKey(cards[previousCardIndex], previousCardIndex)

    return (
      <Animated.View key={key} style={previousCardStyle}>
        {previousCard}
      </Animated.View>
    )
  }

  renderOverlayLabel = (isTop = false) => {
    const {
      disableBottomSwipe,
      disableLeftSwipe,
      disableRightSwipe,
      disableTopSwipe,
      overlayLabels
    } = this.props

    const { labelType } = this.state

    const labelTypeNone = labelType === LABEL_TYPES.NONE
    const directionSwipeLabelDisabled =
      (labelType === LABEL_TYPES.BOTTOM && disableBottomSwipe) ||
      (labelType === LABEL_TYPES.LEFT && disableLeftSwipe) ||
      (labelType === LABEL_TYPES.RIGHT && disableRightSwipe) ||
      (labelType === LABEL_TYPES.TOP && disableTopSwipe)

    if (
      !overlayLabels ||
      !overlayLabels[labelType] ||
      labelTypeNone ||
      directionSwipeLabelDisabled
    ) {
      return null
    }

    return (
      <Animated.View style={this.calculateOverlayLabelWrapperStyle()}>
        {!overlayLabels[labelType].element &&
          <Text style={this.calculateOverlayLabelStyle(isTop)}>
            {overlayLabels[labelType].title}
          </Text>
        }

        {overlayLabels[labelType].element &&
          overlayLabels[labelType].element
        }
      </Animated.View>
    )
  }
}

Swiper.propTypes = {
  animateCardOpacity: PropTypes.bool,
  animateOverlayLabelsOpacity: PropTypes.bool,
  backgroundColor: PropTypes.string,
  cardHorizontalMargin: PropTypes.number,
  cardIndex: PropTypes.number,
  cardStyle: PropTypes.oneOfType([PropTypes.number, PropTypes.object]),
  cardVerticalMargin: PropTypes.number,
  cards: PropTypes.oneOfType([PropTypes.array, PropTypes.object]).isRequired,
  containerStyle: PropTypes.object,
  children: PropTypes.any,
  childrenOnTop: PropTypes.bool,
  dragEnd: PropTypes.func,
  dragStart: PropTypes.func,
  disableBottomSwipe: PropTypes.bool,
  disableLeftSwipe: PropTypes.bool,
  disableRightSwipe: PropTypes.bool,
  disableTopSwipe: PropTypes.bool,
  goBackToPreviousCardOnSwipeBottom: PropTypes.bool,
  goBackToPreviousCardOnSwipeLeft: PropTypes.bool,
  goBackToPreviousCardOnSwipeRight: PropTypes.bool,
  goBackToPreviousCardOnSwipeTop: PropTypes.bool,
  horizontalSwipe: PropTypes.bool,
  horizontalThreshold: PropTypes.number,
  infinite: PropTypes.bool,
  inputCardOpacityRangeX: PropTypes.array,
  inputCardOpacityRangeY: PropTypes.array,
  inputOverlayLabelsOpacityRangeX: PropTypes.array,
  inputOverlayLabelsOpacityRangeY: PropTypes.array,
  inputCardOpacityRange: PropTypes.array,
  inputRotationRange: PropTypes.array,
  keyExtractor: PropTypes.func,
  marginBottom: PropTypes.number,
  marginTop: PropTypes.number,
  onSwiped: PropTypes.func,
  onSwipedAborted: PropTypes.func,
  onSwipedAll: PropTypes.func,
  onSwipedBottom: PropTypes.func,
  onSwipedLeft: PropTypes.func,
  onSwipedRight: PropTypes.func,
  onSwipedTop: PropTypes.func,
  onSwipeDirection: PropTypes.func,
  onSwiping: PropTypes.func,
  onTapCard: PropTypes.func,
  onTapCardDeadZone: PropTypes.number,
  outputCardOpacityRangeX: PropTypes.array,
  outputCardOpacityRangeY: PropTypes.array,
  outputOverlayLabelsOpacityRangeX: PropTypes.array,
  outputOverlayLabelsOpacityRangeY: PropTypes.array,
  outputRotationRange: PropTypes.array,
  outputCardOpacityRange: PropTypes.array,
  overlayLabels: PropTypes.object,
  overlayLabelStyle: PropTypes.object,
  overlayLabelWrapperStyle: PropTypes.object,
  overlayOpacityHorizontalThreshold: PropTypes.number,
  overlayOpacityVerticalThreshold: PropTypes.number,
  pointerEvents: PropTypes.oneOf(['box-none', 'none', 'box-only', 'auto']),
  previousCardDefaultPositionX: PropTypes.number,
  previousCardDefaultPositionY: PropTypes.number,
  redirectBottomToHorizontal: PropTypes.bool,
  bottomSwipeHorizontalThreshold: PropTypes.number,
  renderCard: PropTypes.func.isRequired,
  secondCardZoom: PropTypes.number,
  showSecondCard: PropTypes.bool,
  stackAnimationFriction: PropTypes.number,
  stackAnimationTension: PropTypes.number,
  stackScale: PropTypes.number,
  stackSeparation: PropTypes.number,
  stackSize: PropTypes.number,
  swipeAnimationDuration: PropTypes.number,
  swipeBackCard: PropTypes.bool,
  testID: PropTypes.string,
  topCardResetAnimationFriction: PropTypes.number,
  topCardResetAnimationTension: PropTypes.number,
  verticalSwipe: PropTypes.bool,
  verticalThreshold: PropTypes.number,
  zoomAnimationDuration: PropTypes.number,
  zoomFriction: PropTypes.number
}

Swiper.defaultProps = {
  animateCardOpacity: false,
  animateOverlayLabelsOpacity: false,
  backgroundColor: '#4FD0E9',
  cardHorizontalMargin: 20,
  cardIndex: 0,
  cardStyle: {},
  cardVerticalMargin: 60,
  childrenOnTop: false,
  containerStyle: {},
  disableBottomSwipe: false,
  disableLeftSwipe: false,
  disableRightSwipe: false,
  disableTopSwipe: false,
  horizontalSwipe: true,
  horizontalThreshold: width / 4,
  goBackToPreviousCardOnSwipeBottom: false,
  goBackToPreviousCardOnSwipeLeft: false,
  goBackToPreviousCardOnSwipeRight: false,
  goBackToPreviousCardOnSwipeTop: false,
  infinite: false,
  inputCardOpacityRangeX: [-width / 2, -width / 3, 0, width / 3, width / 2],
  inputCardOpacityRangeY: [-height / 2, -height / 3, 0, height / 3, height / 2],
  inputOverlayLabelsOpacityRangeX: [
    -width / 3,
    -width / 4,
    0,
    width / 4,
    width / 3
  ],
  inputOverlayLabelsOpacityRangeY: [
    -height / 4,
    -height / 5,
    0,
    height / 5,
    height / 4
  ],
  inputRotationRange: [-width / 2, 0, width / 2],
  keyExtractor: null,
  marginBottom: 0,
  marginTop: 0,
  onSwiped: cardIndex => { },
  onSwipedAborted: () => { },
  onSwipedAll: () => { },
  onSwipedBottom: cardIndex => { },
  onSwipedLeft: cardIndex => { },
  onSwipedRight: cardIndex => { },
  onSwipedTop: cardIndex => { },
  onSwipeDirection: () => { },
  onSwiping: () => { },
  onTapCard: (cardIndex) => { },
  onTapCardDeadZone: 5,
  outputCardOpacityRangeX: [0.8, 1, 1, 1, 0.8],
  outputCardOpacityRangeY: [0.8, 1, 1, 1, 0.8],
  outputOverlayLabelsOpacityRangeX: [1, 0, 0, 0, 1],
  outputOverlayLabelsOpacityRangeY: [1, 0, 0, 0, 1],
  outputRotationRange: ['-10deg', '0deg', '10deg'],
  overlayLabels: null,
  overlayLabelStyle: {
    fontSize: 45,
    fontWeight: 'bold',
    borderRadius: 10,
    padding: 10,
    overflow: 'hidden'
  },
  overlayLabelWrapperStyle: {
    position: 'absolute',
    backgroundColor: 'transparent',
    zIndex: 2,
    flex: 1,
    width: '100%',
    height: '100%'
  },
  overlayOpacityHorizontalThreshold: width / 4,
  overlayOpacityVerticalThreshold: height / 5,
  pointerEvents: 'auto',
  previousCardDefaultPositionX: -width,
  previousCardDefaultPositionY: -height,
  redirectBottomToHorizontal: false,
  bottomSwipeHorizontalThreshold: 20,
  secondCardZoom: 0.97,
  showSecondCard: true,
  stackAnimationFriction: 7,
  stackAnimationTension: 40,
  stackScale: 3,
  stackSeparation: 10,
  stackSize: 1,
  swipeAnimationDuration: 350,
  swipeBackCard: false,
  topCardResetAnimationFriction: 7,
  topCardResetAnimationTension: 40,
  verticalSwipe: true,
  verticalThreshold: width / 4,
  zoomAnimationDuration: 100,
  zoomFriction: 7
}

const debugStyles = StyleSheet.create({
  debugContainer: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(255, 0, 0, 0.8)',
    borderRadius: 15,
    width: 30,
    height: 30,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100
  },
  debugText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold'
  }
})

export default Swiper
