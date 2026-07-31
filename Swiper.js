import isEqual from 'lodash/isEqual'
import PropTypes from 'prop-types'
import React, { Component } from 'react'
import { Animated, Dimensions, InteractionManager, StyleSheet, Text, View } from 'react-native'
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
    this.props.dragStart && this.props.dragStart()
    if (!this.state.panResponderLocked) {
      this.state.pan.setOffset({ x: 0, y: 0 })
    }
    this.state.pan.setValue({ x: 0, y: 0 })
  }

  onGestureMove = (dx, dy) => {
    const { horizontalSwipe, verticalSwipe } = this.props

    // Update the animated values
    const x = horizontalSwipe ? dx : 0
    const y = verticalSwipe ? dy : 0
    this.state.pan.setValue({ x, y })

    // Update internal tracking
    this._animatedValueX = x
    this._animatedValueY = y

    this.props.onSwiping(x, y)

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

    if (isSwipingRight) {
      this.setState({ labelType: LABEL_TYPES.RIGHT })
    } else if (isSwipingLeft) {
      this.setState({ labelType: LABEL_TYPES.LEFT })
    } else if (isSwipingTop) {
      this.setState({ labelType: LABEL_TYPES.TOP })
    } else if (isSwipingBottom) {
      this.setState({ labelType: LABEL_TYPES.BOTTOM })
    } else {
      this.setState({ labelType: LABEL_TYPES.NONE })
    }

    const { onTapCardDeadZone } = this.props
    if (
      x < -onTapCardDeadZone ||
      x > onTapCardDeadZone ||
      y < -onTapCardDeadZone ||
      y > onTapCardDeadZone
    ) {
      this.setState({ slideGesture: true })
    }
  }

  onGestureEnd = (dx, dy, velocityX, velocityY) => {
    this.props.dragEnd && this.props.dragEnd()

    if (this.state.panResponderLocked) {
      this.state.pan.setValue({ x: 0, y: 0 })
      this.state.pan.setOffset({ x: 0, y: 0 })
      return
    }

    const { horizontalThreshold, verticalThreshold } = this.props
    const x = this.props.horizontalSwipe ? dx : 0
    const y = this.props.verticalSwipe ? dy : 0

    // No "swipe down" gesture exists: when redirectBottomToHorizontal is on, a
    // downward drag (y > 0) has no bottom action and instead commits left/right
    // by the sign of its horizontal lean — a slight down-left goes Left, a
    // slight down-right goes Right — removing the bottom deadzone that would
    // otherwise snap these back. Up-swipes (y < 0) are untouched, and a strong
    // horizontal drag (|x| past the threshold) still resolves via the normal
    // priority below, so this only rescues the down-dominant, slight-lean case.
    if (
      this.props.redirectBottomToHorizontal &&
      y > verticalThreshold &&
      Math.abs(x) > 0 &&
      Math.abs(x) <= horizontalThreshold
    ) {
      const toLeft = x < 0
      const disabled = toLeft
        ? this.props.disableLeftSwipe
        : this.props.disableRightSwipe
      if (!disabled) {
        this.swipeCard(
          toLeft ? this.props.onSwipedLeft : this.props.onSwipedRight,
          toLeft ? -horizontalThreshold : horizontalThreshold,
          0
        )
        this.setState({ labelType: LABEL_TYPES.NONE, slideGesture: false })
        return
      }
    }

    const animatedValueX = Math.abs(x)
    const animatedValueY = Math.abs(y)

    const isSwiping =
      animatedValueX > horizontalThreshold || animatedValueY > verticalThreshold

    if (isSwiping && this.validPanResponderRelease()) {
      const onSwipeDirectionCallback = this.getOnSwipeDirectionCallback(x, y)
      this.swipeCard(onSwipeDirectionCallback)
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
    if (this.state.panResponderLocked) return
    this.setState({ panResponderLocked: true })
    this.animateStack()
    Animated.timing(this.state.pan, {
      toValue: {
        x: x * SWIPE_MULTIPLY_FACTOR,
        y: y * SWIPE_MULTIPLY_FACTOR
      },
      duration: this.props.swipeAnimationDuration,
      useNativeDriver: true
    }).start(() => {
      // Animation completed - card is off-screen and invisible
      // Update z-indexes immediately
      const { swipedCount } = this.state
      const { stackSize } = this.props
      const swipedSlot = swipedCount % stackSize
      const newTopSlot = (swipedCount + 1) % stackSize
      for (let i = 0; i < stackSize; i++) {
        const distanceFromTop = (i - newTopSlot + stackSize) % stackSize
        this._slotZIndexes[i] = stackSize - distanceFromTop
      }

      // Set swiped slot opacity to 0 (it will fade in after pan reset)
      this._slotOpacities[swipedSlot].setValue(0)

      // Force re-render to apply z-index and opacity=0
      this.forceUpdate()

      // Small delay to ensure z-index and opacity are visually applied before pan reset
      setTimeout(() => {
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
      }, 20)
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

          // Fade in the swiped slot (now at bottom of stack)
          Animated.timing(this._slotOpacities[swipedSlot], {
            toValue: 1,
            duration: 250,
            useNativeDriver: true
          }).start()
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
    this.state.pan.x.addListener(value => this._animatedValueX = value.value)
    this.state.pan.y.addListener(value => this._animatedValueY = value.value)
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
  verticalThreshold: height / 5,
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
